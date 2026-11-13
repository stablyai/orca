import { pasteboard } from '@kit.BasicServicesKit';
import { audio } from '@kit.AudioKit';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { window } from '@kit.ArkUI';
import { DICTATION_ENGINE_ONDEVICE, readDictationEngine } from '../settings/SettingsStore';
import { playHapticFeedback } from '../settings/HapticFeedback';
import { base64Encode } from '../transport/crypto/Bytes';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { NativeSpeech } from './NativeSpeech';
import { NativeImageActions } from './NativeImageActions';
import { NativePdfViewer, PdfPreview } from './NativePdfViewer';

const AUDIO_LIMIT = 160000;
const MEDIA_LIMIT = 18 * 1024 * 1024;
const PHOTO_PIXEL_LIMIT = 32 * 1024 * 1024;
const READ_LIMIT = 384 * 1024;

interface MediaRecord { bytes: Uint8Array; mime: string; name: string; }
export interface ClipboardPastePrompt {
  confirm: () => Promise<void>;
  cancel: () => void;
}

export const NATIVE_DEVICE_METHODS: string[] = ['native.clipboard.read', 'native.clipboard.write',
  'native.media.pick', 'native.media.read', 'native.media.release', 'native.media.name',
  'native.audio.start', 'native.audio.read', 'native.audio.stop',
  'native.speech.act', 'native.image.act', 'native.pdf.view'];

export class NativeMediaTooLargeError extends Error {
  constructor() { super('Selected media is too large'); }
}

/** Each bridge owns its native resources; handles and microphone never outlive the document. */
export class NativeDevice {
  readonly methods: string[] = NATIVE_DEVICE_METHODS;
  private context: common.UIAbilityContext;
  private speech: NativeSpeech;
  private images: NativeImageActions;
  private pdf: NativePdfViewer;
  private capturer: audio.AudioCapturer | null = null;
  private recording = false;
  private pcm: Uint8Array = new Uint8Array(0);
  private dropped = 0;
  private interruption: string | null = null;
  private media: Map<string, MediaRecord> = new Map();
  private counter = 0;
  private generation = 0;
  private disposed = false;
  private isActive: () => boolean;
  private starting = false;
  private captureRelease: Promise<void> | null = null;
  private recordingWindow: window.Window | null = null;
  private previousKeepScreenOn = false;
  private picking = false;
  private selectionGeneration = 0;
  private clipboardPrompt: ClipboardPastePrompt | null = null;
  private onClipboardPrompt: (prompt: ClipboardPastePrompt | null) => void;

  constructor(context: common.UIAbilityContext, client: SpikeRpcClient | null = null,
    onPdfPreview: (preview: PdfPreview | null) => void = (_preview: PdfPreview | null): void => {},
    onClipboardPrompt: (prompt: ClipboardPastePrompt | null) => void = (_prompt: ClipboardPastePrompt | null): void => {},
    isActive: () => boolean = (): boolean => true) {
    this.context = context; this.isActive = isActive; this.speech = new NativeSpeech(context, isActive);
    this.images = new NativeImageActions(context, isActive); this.pdf = new NativePdfViewer(context, client, onPdfPreview, isActive);
    this.onClipboardPrompt = onClipboardPrompt;
  }
  setDesktopClient(client: SpikeRpcClient | null): void { this.pdf.setClient(client); }
  closePdf(): Promise<void> { return this.pdf.cancel(); }
  async dispose(): Promise<void> {
    this.disposed = true; this.generation++; this.selectionGeneration++; this.media.clear();
    this.clipboardPrompt?.cancel();
    this.speech.dispose(); this.images.dispose();
    let pdf = this.pdf.dispose();
    await this.stopCapture(); await pdf; this.pcm = new Uint8Array(0);
  }
  async pause(covered: boolean = false): Promise<void> {
    this.selectionGeneration++; this.images.pause();
    this.clipboardPrompt?.cancel();
    let pdf = covered ? this.pdf.cancel() : this.pdf.pause();
    await this.interruptCapture('blocked'); await pdf;
  }

  private interruptCapture(reason: string): Promise<void> {
    if (this.recording) {
      this.interruption = reason;
      this.speech.endInput();
    }
    return this.stopCapture();
  }

  private async stopCapture(): Promise<void> {
    this.generation++; this.recording = false;
    if (this.captureRelease) { await this.captureRelease; return; }
    let capturer = this.capturer; this.capturer = null;
    let recordingWindow = this.recordingWindow; this.recordingWindow = null;
    if (!capturer && !recordingWindow) { return; }
    this.captureRelease = this.releaseCapture(capturer, recordingWindow).finally((): void => { this.captureRelease = null; });
    await this.captureRelease;
  }

  private async releaseCapture(capturer: audio.AudioCapturer | null, recordingWindow: window.Window | null): Promise<void> {
    if (capturer) {
      try { capturer.off('readData'); await capturer.stop(); } catch (e) { }
      try { await capturer.release(); } catch (e) { }
    }
    if (recordingWindow) { try { await recordingWindow.setWindowKeepScreenOn(this.previousKeepScreenOn); } catch (e) { } }
  }
  private params(value: ESObject, keys: string[]): ESObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid device parameters'); }
    let actual = Object.keys(value);
    if (actual.length !== keys.length || !actual.every((key: string): boolean => keys.includes(key))) {
      throw new Error('Invalid device parameters');
    }
    return value;
  }
  async serve(method: string, value: ESObject): Promise<Object> {
    if (this.disposed) { throw new Error('Device session closed'); }
    let cleanup = ['native.audio.read', 'native.audio.stop', 'native.media.read', 'native.media.name', 'native.media.release'].includes(method)
      || (method === 'native.speech.act' && ['read', 'finish', 'cancel'].includes(value?.['action']))
      || (method === 'native.pdf.view' && value?.['action'] === 'cancel');
    if (!cleanup && !this.isActive()) { throw new Error('Device page is not active'); }
    if (method === 'native.speech.act') { return this.speech.serve(value); }
    if (method === 'native.image.act') { return this.images.serve(value); }
    if (method === 'native.pdf.view') { return this.pdf.serve(value); }
    if (method === 'native.clipboard.read') {
      let params: ESObject = this.params(value, ['mime']);
      if (params['mime'] !== 'text') { throw new Error('Text only'); }
      let generation = this.selectionGeneration;
      let data = await this.readClipboard(pasteboard.MIMETYPE_TEXT_PLAIN); this.checkSelection(generation);
      let result: Record<string, Object> = { 'value': data?.getPrimaryText() ?? '' }; return result;
    }
    if (method === 'native.clipboard.write') {
      let params: ESObject = this.params(value, ['mime', 'value']);
      if (params['mime'] !== 'text' || typeof params['value'] !== 'string' || params['value'].length > 400000) {
        throw new Error('Invalid clipboard text');
      }
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, params['value']));
      let result: Record<string, Object> = { 'written': true }; return result;
    }
    if (method === 'native.audio.start') { return this.startAudio(this.params(value, ['sampleRate'])['sampleRate']); }
    if (method === 'native.audio.read') {
      let max: number = this.params(value, ['maxBytes'])['maxBytes'];
      if (!Number.isInteger(max) || max < 1 || max > AUDIO_LIMIT) { throw new Error('Invalid audio read'); }
      let chunk = this.drainAudio(max);
      let result: ESObject = { base64: chunk, droppedBytes: this.dropped, recording: this.recording, interruption: this.interruption };
      this.dropped = 0; this.interruption = null; return result;
    }
    if (method === 'native.audio.stop') {
      this.params(value, []);
      let stopped = this.recording; await this.stopCapture();
      let result: Record<string, Object> = { 'stopped': stopped, 'base64': this.drainAudio(AUDIO_LIMIT), 'droppedBytes': this.dropped };
      this.dropped = 0; return result;
    }
    if (method === 'native.media.pick') {
      let params: ESObject = this.params(value, ['source', 'multiple']);
      return this.pickMedia(params['source'], params['multiple']);
    }
    let params: ESObject = this.params(value, method === 'native.media.read' ? ['handle', 'offset', 'length'] : ['handle']);
    let handle: string = params['handle'];
    if (typeof handle !== 'string' || handle.length < 1 || handle.length > 64) { throw new Error('Invalid media handle'); }
    let record = this.media.get(handle);
    if (method === 'native.media.release') {
      let result: Record<string, Object> = { 'released': this.media.delete(handle) }; return result;
    }
    if (method === 'native.media.name') { let result: ESObject = { name: record ? record.name : null }; return result; }
    if (method !== 'native.media.read' || !record) { throw new Error('Media unavailable'); }
    let offset: number = params['offset']; let length: number = params['length'];
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || offset > record.bytes.length
      || length < 1 || length > READ_LIMIT) { throw new Error('Invalid media range'); }
    let end = Math.min(record.bytes.length, offset + length);
    let result: Record<string, Object> = { 'base64': base64Encode(record.bytes.subarray(offset, end)), 'eof': end === record.bytes.length };
    return result;
  }
  async notifyExternalLink(target: string): Promise<void> {
    if (this.disposed || !this.isActive() || typeof target !== 'string' || target.length > 8192 || /[\x00-\x20\x7f]/.test(target)
      || !/^(?:https?:\/\/[^/@?#]+(?:[/?#]|$)|mailto:[^@\s]+@[^\s]+)/i.test(target)) { throw new Error('Invalid external link'); }
    await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: target });
  }

  async notifyHaptic(kind: string): Promise<void> {
    if (this.disposed || !this.isActive() || !['mediumImpact', 'selection', 'success', 'error', 'edgeBump'].includes(kind)) { throw new Error('Invalid haptic feedback'); }
    await playHapticFeedback(kind);
  }

  private checkSelection(generation: number): void {
    if (this.disposed || generation !== this.selectionGeneration || !this.isActive()) { throw new Error('Selection cancelled'); }
  }

  private async readClipboard(mime: string): Promise<pasteboard.PasteData | null> {
    let system = pasteboard.getSystemPasteboard();
    if (!system.hasDataType(mime)) { return null; }
    if (this.clipboardPrompt) { throw new Error('Clipboard paste already pending'); }
    return new Promise<pasteboard.PasteData>((resolve, reject) => {
      let reading = false;
      let finish = (): boolean => {
        if (this.clipboardPrompt !== prompt) { return false; }
        this.clipboardPrompt = null; this.onClipboardPrompt(null);
        return true;
      };
      let prompt: ClipboardPastePrompt = {
        confirm: async (): Promise<void> => {
          if (reading || this.clipboardPrompt !== prompt) { return; }
          reading = true;
          try {
            let data = await system.getData();
            if (finish()) { resolve(data); }
          } catch (e) {
            if (finish()) { reject(new Error('Clipboard read failed')); }
          }
        },
        cancel: (): void => { if (finish()) { reject(new Error('Clipboard paste cancelled')); } }
      };
      this.clipboardPrompt = prompt; this.onClipboardPrompt(prompt);
    });
  }
  private drainAudio(max: number): string {
    let size = Math.min(max, this.pcm.length);
    let result = base64Encode(this.pcm.subarray(0, size)); this.pcm = this.pcm.slice(size); return result;
  }
  private async startAudio(sampleRate: number): Promise<Object> {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000
      || this.starting || this.recording || this.captureRelease) { throw new Error('Microphone unavailable'); }
    this.starting = true; let generation = ++this.generation;
    try {
      let phoneOnly = await readDictationEngine(this.context) === DICTATION_ENGINE_ONDEVICE;
      if (this.disposed || generation !== this.generation || !this.isActive()) { throw new Error('Capture cancelled'); }
      let unavailable: Record<string, Object> = { 'started': false, 'sampleRate': 16000, 'permission': 'granted' };
      if (phoneOnly && !this.speech.canCapture()) { return unavailable; }
      let permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context, ['ohos.permission.MICROPHONE']);
      if (permission.authResults[0] !== 0) {
        this.speech.cancel();
        let denied: Record<string, Object> = { 'started': false, 'sampleRate': 16000, 'permission': 'denied' }; return denied;
      }
      if (this.disposed || generation !== this.generation || !this.isActive()) { throw new Error('Capture cancelled'); }
      if (phoneOnly && !this.speech.canCapture()) { return unavailable; }
      let options: audio.AudioCapturerOptions = {
        streamInfo: { samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000, channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE, encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW },
        capturerInfo: { source: audio.SourceType.SOURCE_TYPE_MIC, capturerFlags: 0 }
      };
      let capturer = await audio.createAudioCapturer(options);
      if (this.disposed || generation !== this.generation || !this.isActive()) { await capturer.release(); throw new Error('Capture cancelled'); }
      this.capturer = capturer;
      let recordingWindow = await window.getLastWindow(this.context);
      if (this.disposed || generation !== this.generation || !this.isActive()) { await this.stopCapture(); throw new Error('Capture cancelled'); }
      this.recordingWindow = recordingWindow;
      let previousKeepScreenOn = recordingWindow.getWindowProperties().isKeepScreenOn;
      this.previousKeepScreenOn = previousKeepScreenOn;
      await recordingWindow.setWindowKeepScreenOn(true);
      if (this.disposed || generation !== this.generation || !this.isActive()) {
        try { await recordingWindow.setWindowKeepScreenOn(previousKeepScreenOn); } catch (e) { }
        await this.stopCapture(); throw new Error('Capture cancelled');
      }
      if (phoneOnly && !this.speech.canCapture()) { await this.stopCapture(); return unavailable; }
      this.pcm = new Uint8Array(0); this.dropped = 0; this.interruption = null;
      this.recording = true;
      capturer.on('readData', (data: ArrayBuffer): void => {
        if (!this.recording || generation !== this.generation) { return; }
        let incoming = new Uint8Array(data); this.speech.feed(incoming);
        if (phoneOnly) { return; }
        let size = this.pcm.length + incoming.length;
        let skip = Math.max(0, size - AUDIO_LIMIT); this.dropped += skip;
        let next = new Uint8Array(Math.min(size, AUDIO_LIMIT));
        if (skip < this.pcm.length) {
          let held = this.pcm.subarray(skip); next.set(held); next.set(incoming, held.length);
        } else { next.set(incoming.subarray(skip - this.pcm.length)); }
        this.pcm = next;
      });
      capturer.on('stateChange', (state: audio.AudioState): void => {
        if (generation === this.generation && this.recording
          && (state === audio.AudioState.STATE_PAUSED || state === audio.AudioState.STATE_STOPPED
            || state === audio.AudioState.STATE_RELEASED)) {
          this.interruptCapture('blocked').catch(() => {});
        }
      });
      capturer.on('audioInterrupt', (event: audio.InterruptEvent): void => {
        if (!this.recording || generation !== this.generation) { return; }
        if (event.eventType === audio.InterruptType.INTERRUPT_TYPE_BEGIN
          && (event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE || event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP)) {
          this.interruptCapture('began').catch(() => {});
        }
      });
      await capturer.start();
      if (this.disposed || generation !== this.generation || !this.isActive()) { await this.stopCapture(); throw new Error('Capture cancelled'); }
      let result: Record<string, Object> = { 'started': true, 'sampleRate': 16000, 'permission': 'granted' }; return result;
    } catch (e) { this.speech.cancel(); await this.stopCapture(); throw new Error((e as Error).message); }
    finally { this.starting = false; }
  }
  private async pickMedia(source: string, multiple: boolean): Promise<Object> {
    if (!['library', 'files', 'clipboard'].includes(source) || typeof multiple !== 'boolean' || this.picking) {
      throw new Error('Invalid media selection');
    }
    this.picking = true; let generation = this.selectionGeneration;
    let pending: MediaRecord[] = [];
    try {
      if (this.media.size >= 8) { throw new Error('Too many selected files'); }
      if (source === 'clipboard') {
        let data = await this.readClipboard(pasteboard.MIMETYPE_PIXELMAP); this.checkSelection(generation);
        let pixel = data?.getPrimaryPixelMap();
        if (pixel) {
          let packer = image.createImagePacker();
          try {
            let info = await pixel.getImageInfo(); this.checkSelection(generation);
            if (info.size.width * info.size.height > 40000000) { throw new Error('Image dimensions too large'); }
            let packed = await packer.packing(pixel, { format: 'image/png', quality: 100 });
            this.checkSelection(generation);
            if (packed.byteLength > MEDIA_LIMIT) { throw new Error('Image too large'); }
            pending.push({ bytes: new Uint8Array(packed), mime: 'image/png', name: 'clipboard.png' });
          } finally { await packer.release(); await pixel.release(); }
        }
      } else {
        let uris: string[] = [];
        let max = Math.min(multiple ? 8 : 1, 8 - this.media.size);
        if (max <= 0) { throw new Error('Too many selected files'); }
        if (source === 'library') {
          let options = new photoAccessHelper.PhotoSelectOptions();
          options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
          options.maxSelectNumber = max;
          options.isSelectionNumberVisible = multiple;
          options.preferredCompatibleMode = photoAccessHelper.PreferredCompatibleMode.COMPATIBLE;
          let selected = await new photoAccessHelper.PhotoViewPicker().select(options); uris = selected.photoUris;
        } else {
          let options = new picker.DocumentSelectOptions(); options.maxSelectNumber = max;
          uris = await new picker.DocumentViewPicker(this.context).select(options);
        }
        this.checkSelection(generation);
        for (let i = 0; i < uris.length; i++) {
          this.checkSelection(generation);
          let file = await fs.open(uris[i], fs.OpenMode.READ_ONLY);
          try {
            let stat = await fs.stat(file.fd); this.checkSelection(generation);
            if (stat.size > MEDIA_LIMIT) { throw new NativeMediaTooLargeError(); }
            if (!Number.isSafeInteger(stat.size) || stat.size < 0) { throw new Error('File size unavailable'); }
            let bytes = new Uint8Array(stat.size); let offset = 0;
            while (offset < bytes.length) {
              let part = new ArrayBuffer(Math.min(READ_LIMIT, bytes.length - offset));
              let read = await fs.read(file.fd, part, { offset: offset, length: part.byteLength }); this.checkSelection(generation);
              if (read <= 0) { throw new Error('File read interrupted'); }
              bytes.set(new Uint8Array(part, 0, read), offset); offset += read;
            }
            let name = 'attachment';
            try { name = decodeURIComponent(uris[i].split('/').pop() ?? 'attachment'); } catch (e) { }
            name = name.replace(/[\x00-\x1f\\/]/g, '_').slice(0, 255) || 'attachment';
            let ext = name.toLowerCase().split('.').pop();
            let mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
            if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) { mime = 'image/png'; }
            else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { mime = 'image/jpeg'; }
            else if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[8] === 87 && bytes[9] === 69) { mime = 'image/webp'; }
            else if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) { mime = 'image/gif'; }
            else if (source === 'library') {
              // The compatibility preference can still return an original HEIF photo.
              bytes = await this.encodePickedPhoto(file.fd, generation);
              mime = 'image/jpeg';
              name = `${name.replace(/\.[^.]+$/, '').slice(0, 251) || 'attachment'}.jpg`;
            }
            pending.push({ bytes: bytes, mime: mime, name: name });
          } finally { await fs.close(file); }
        }
      }
      this.checkSelection(generation);
      if (this.disposed || this.media.size + pending.length > 8) { throw new Error('Selection cancelled'); }
      let items: Object[] = [];
      for (let i = 0; i < pending.length; i++) {
        this.counter++; let handle = `media-${this.counter}`; let record = pending[i]; this.media.set(handle, record);
        let item: Record<string, Object> = { 'handle': handle, 'mime': record.mime, 'byteLength': record.bytes.length }; items.push(item);
      }
      let result: Record<string, Object> = { 'items': items }; return result;
    } finally { this.picking = false; }
  }

  private async encodePickedPhoto(fd: number, generation: number): Promise<Uint8Array> {
    let photo = image.createImageSource(fd);
    let packer: image.ImagePacker | undefined;
    try {
      let info = await photo.getImageInfo(); this.checkSelection(generation);
      if (info.size.width * info.size.height > PHOTO_PIXEL_LIMIT) { throw new NativeMediaTooLargeError(); }
      packer = image.createImagePacker();
      let packed = await packer.packToData(photo, { format: 'image/jpeg', quality: 100, needsPackProperties: true });
      this.checkSelection(generation);
      if (packed.byteLength > MEDIA_LIMIT) { throw new NativeMediaTooLargeError(); }
      return new Uint8Array(packed);
    } finally {
      try { await packer?.release(); } finally { await photo.release(); }
    }
  }
}
