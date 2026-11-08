import { pasteboard } from '@kit.BasicServicesKit';
import { audio } from '@kit.AudioKit';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { base64Encode } from '../transport/crypto/Bytes';

const AUDIO_LIMIT = 160000;
const MEDIA_LIMIT = 18 * 1024 * 1024;
const READ_LIMIT = 384 * 1024;

interface MediaRecord { bytes: Uint8Array; mime: string; name: string; }

/** Each bridge owns its native resources; handles and microphone never outlive the document. */
export class NativeDevice {
  readonly methods: string[] = ['native.clipboard.read', 'native.clipboard.write',
    'native.media.pick', 'native.media.read', 'native.media.release', 'native.media.name',
    'native.audio.start', 'native.audio.read', 'native.audio.stop'];
  private context: common.UIAbilityContext;
  private capturer: audio.AudioCapturer | null = null;
  private recording = false;
  private pcm: Uint8Array = new Uint8Array(0);
  private dropped = 0;
  private interruption: string | null = null;
  private media: Map<string, MediaRecord> = new Map();
  private counter = 0;
  private generation = 0;
  private disposed = false;
  private starting = false;
  private picking = false;

  constructor(context: common.UIAbilityContext) { this.context = context; }
  async dispose(): Promise<void> {
    this.disposed = true; this.generation++; this.media.clear();
    await this.stopCapture(); this.pcm = new Uint8Array(0);
  }
  async stopCapture(): Promise<void> {
    this.generation++; this.recording = false;
    let capturer = this.capturer; this.capturer = null;
    if (capturer) {
      try { capturer.off('readData'); await capturer.stop(); } catch (e) { }
      try { await capturer.release(); } catch (e) { }
    }
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
    if (method === 'native.clipboard.read') {
      let params: ESObject = this.params(value, ['mime']);
      if (params['mime'] !== 'text') { throw new Error('Text only'); }
      await this.ensureClipboardPermission();
      let data = await pasteboard.getSystemPasteboard().getData();
      let result: Record<string, Object> = { 'value': data.getPrimaryText() ?? '' }; return result;
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
      this.generation++;
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
    if (typeof handle !== 'string' || handle.length > 64) { throw new Error('Invalid media handle'); }
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
  private async ensureClipboardPermission(): Promise<void> {
    let result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context, ['ohos.permission.READ_PASTEBOARD']);
    if (result.authResults[0] !== 0 || this.disposed) { throw new Error('Clipboard access denied'); }
  }
  private drainAudio(max: number): string {
    let size = Math.min(max, this.pcm.length);
    let result = base64Encode(this.pcm.subarray(0, size)); this.pcm = this.pcm.slice(size); return result;
  }
  private async startAudio(sampleRate: number): Promise<Object> {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || this.starting || this.recording) { throw new Error('Microphone unavailable'); }
    this.starting = true; let generation = ++this.generation;
    try {
      let permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context, ['ohos.permission.MICROPHONE']);
      if (permission.authResults[0] !== 0) {
        let denied: Record<string, Object> = { 'started': false, 'sampleRate': 16000, 'permission': 'denied' }; return denied;
      }
      if (this.disposed || generation !== this.generation) { throw new Error('Capture cancelled'); }
      let options: audio.AudioCapturerOptions = {
        streamInfo: { samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000, channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE, encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW },
        capturerInfo: { source: audio.SourceType.SOURCE_TYPE_MIC, capturerFlags: 0 }
      };
      let capturer = await audio.createAudioCapturer(options);
      if (this.disposed || generation !== this.generation) { await capturer.release(); throw new Error('Capture cancelled'); }
      this.capturer = capturer; this.pcm = new Uint8Array(0); this.dropped = 0; this.interruption = null;
      this.recording = true;
      capturer.on('readData', (data: ArrayBuffer): void => {
        if (!this.recording || generation !== this.generation) { return; }
        let incoming = new Uint8Array(data); let size = this.pcm.length + incoming.length;
        let skip = Math.max(0, size - AUDIO_LIMIT); this.dropped += skip;
        let next = new Uint8Array(Math.min(size, AUDIO_LIMIT));
        if (skip < this.pcm.length) {
          let held = this.pcm.subarray(skip); next.set(held); next.set(incoming, held.length);
        } else { next.set(incoming.subarray(skip - this.pcm.length)); }
        this.pcm = next;
      });
      capturer.on('audioInterrupt', (event: audio.InterruptEvent): void => {
        if (event.eventType === audio.InterruptType.INTERRUPT_TYPE_BEGIN) {
          this.interruption = 'began'; this.stopCapture().catch(() => {});
        } else { this.interruption = 'ended'; }
      });
      await capturer.start();
      if (this.disposed || generation !== this.generation) { await this.stopCapture(); throw new Error('Capture cancelled'); }
      let result: Record<string, Object> = { 'started': true, 'sampleRate': 16000, 'permission': 'granted' }; return result;
    } catch (e) { await this.stopCapture(); throw new Error((e as Error).message); }
    finally { this.starting = false; }
  }
  private async pickMedia(source: string, multiple: boolean): Promise<Object> {
    if (!['library', 'files', 'clipboard'].includes(source) || typeof multiple !== 'boolean' || this.picking) {
      throw new Error('Invalid media selection');
    }
    this.picking = true;
    let pending: MediaRecord[] = [];
    try {
      if (source === 'clipboard') {
        await this.ensureClipboardPermission();
        let data = await pasteboard.getSystemPasteboard().getData();
        let pixel = data.getPrimaryPixelMap();
        if (pixel) {
          let packer = image.createImagePacker();
          try {
            let packed = await packer.packing(pixel, { format: 'image/png', quality: 100 });
            if (packed.byteLength > MEDIA_LIMIT) { throw new Error('Image too large'); }
            pending.push({ bytes: new Uint8Array(packed), mime: 'image/png', name: 'clipboard.png' });
          } finally { await packer.release(); }
        }
      } else {
        let uris: string[] = [];
        let max = multiple ? 8 - this.media.size : 1;
        if (max <= 0) { throw new Error('Too many selected files'); }
        if (source === 'library') {
          let options = new photoAccessHelper.PhotoSelectOptions();
          options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE; options.maxSelectNumber = max;
          let selected = await new photoAccessHelper.PhotoViewPicker().select(options); uris = selected.photoUris;
        } else {
          let options = new picker.DocumentSelectOptions(); options.maxSelectNumber = max;
          uris = await new picker.DocumentViewPicker(this.context).select(options);
        }
        for (let i = 0; i < uris.length; i++) {
          let file = await fs.open(uris[i], fs.OpenMode.READ_ONLY);
          try {
            let stat = await fs.stat(file.fd);
            if (stat.size > MEDIA_LIMIT || stat.size < 0) { throw new Error('File too large'); }
            let bytes = new Uint8Array(stat.size); let offset = 0;
            while (offset < bytes.length) {
              let part = new ArrayBuffer(Math.min(READ_LIMIT, bytes.length - offset));
              let read = await fs.read(file.fd, part, { offset: offset, length: part.byteLength });
              if (read <= 0) { throw new Error('File read interrupted'); }
              bytes.set(new Uint8Array(part, 0, read), offset); offset += read;
            }
            let name = decodeURIComponent(uris[i].split('/').pop() ?? 'attachment').slice(0, 255);
            let ext = name.toLowerCase().split('.').pop();
            let mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
            pending.push({ bytes: bytes, mime: mime, name: name });
          } finally { await fs.close(file); }
        }
      }
      if (this.disposed || this.media.size + pending.length > 8) { throw new Error('Selection cancelled'); }
      let items: Object[] = [];
      for (let i = 0; i < pending.length; i++) {
        this.counter++; let handle = `media-${this.counter}`; let record = pending[i]; this.media.set(handle, record);
        let item: Record<string, Object> = { 'handle': handle, 'mime': record.mime, 'byteLength': record.bytes.length }; items.push(item);
      }
      let result: Record<string, Object> = { 'items': items }; return result;
    } finally { this.picking = false; }
  }
}
