import { audio } from '@kit.AudioKit';
import { util } from '@kit.ArkTS';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { SpikeRpcClient, RpcResponse, RpcSuccess, RpcFailure } from '../transport/SpikeRpcClient';

/**
 * Voice dictation capture (Phase 4a): microphone -> PCM chunks -> speech.dictation.* RPC.
 *
 * Audio spec mirrors upstream packages/expo-two-way-audio: 16-bit little-endian mono PCM
 * at 16 kHz (AudioCapturer gives S16LE frames; SOURCE_TYPE_MIC is the raw mic source).
 *
 * RPC contract (src/shared/rpc-contract/speech-params.ts):
 * - speech.dictation.start  {"dictationId", "modelId"?}
 * - speech.dictation.chunk  {"dictationId","audioBase64","sampleRate":16000,"seq"} — seq
 *   counts up from 0 per dictation; chunks are capped at 5 s of audio upstream.
 * - speech.dictation.finish/cancel {"dictationId"}.
 * Newer hosts may return partial text on chunk replies ({"text","revision"} in the
 * result) and on the finish reply; those are surfaced through onTranscript when present.
 *
 * Chunk sends are serialized through one promise chain so seq order matches capture
 * order even when replies return out of order.
 */

const DICTATION_SAMPLE_RATE = 16000;
/** ~4KB of 16 kHz S16LE mono ≈ 128 ms — comfortably inside the 250 ms/5 s upstream windows. */
const CHUNK_BYTES = 4096;
const PCM_INT16_MAX = 32767;

export class DictationController {
  private context: common.UIAbilityContext;
  private onVolume: (level: number) => void;
  private logSink: ((line: string) => void) | null = null;
  /** Partial/final transcript hook for UI; set by the caller. */
  onTranscript: ((text: string) => void) | null = null;

  private rpc: SpikeRpcClient | null = null;
  private capturer: audio.AudioCapturer | null = null;
  private activeId: string = '';
  private seq: number = 0;
  private running: boolean = false;
  private starting: boolean = false;
  private generation: number = 0;
  private queuedBytes: number = 0;
  private pending: Uint8Array = new Uint8Array(0);
  private sendChain: Promise<void> = Promise.resolve();

  constructor(context: common.UIAbilityContext, onVolume: (level: number) => void) {
    this.context = context;
    this.onVolume = onVolume;
  }

  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }

  private log(line: string): void {
    if (this.logSink) {
      this.logSink(line);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getDictationId(): string {
    return this.activeId;
  }

  /**
   * Requests mic permission, runs speech.dictation.setup + start, then opens the
   * capturer and streams chunks. Returns false (with a log line) on any failure.
   */
  async start(dictationId: string, rpc: SpikeRpcClient): Promise<boolean> {
    if (this.running || this.capturer !== null || this.starting) { return false; }
    this.starting = true; let generation = ++this.generation;
    try {
      if (this.running || this.capturer !== null) {
        this.log('听写已在进行中，先停止再开始');
        return false;
      }
      let granted = await this.ensureMicPermission();
      if (generation !== this.generation) { return false; }
      if (!granted) {
        this.log('麦克风权限未授予');
        return false;
      }
      let setupParams: Record<string, number> = { 'sampleRate': DICTATION_SAMPLE_RATE };
      let setupResponse: RpcResponse = await rpc.request('speech.dictation.setup',
        JSON.stringify(setupParams));
      if (generation !== this.generation) { return false; }
      if (!(setupResponse instanceof RpcSuccess)) {
        this.log(`dictation.setup 失败: ${(setupResponse as RpcFailure).errorMessage}`);
        return false;
      }
      let startParams: Record<string, string> = { 'dictationId': dictationId };
      let startResponse: RpcResponse = await rpc.request('speech.dictation.start',
        JSON.stringify(startParams));
      if (generation !== this.generation) {
        await rpc.request('speech.dictation.cancel', JSON.stringify(startParams)); return false;
      }
      if (!(startResponse instanceof RpcSuccess)) {
        this.log(`dictation.start 失败: ${(startResponse as RpcFailure).errorMessage}`);
        return false;
      }
      this.rpc = rpc;
      this.activeId = dictationId;
      this.seq = 0; this.queuedBytes = 0;
      this.pending = new Uint8Array(0);
      this.sendChain = Promise.resolve();
      await this.startCapturer(dictationId, rpc, generation);
      if (generation !== this.generation) { await this.closeCapturer(); return false; }
      this.running = true;
      this.log(`听写已开始 (${dictationId})`);
      return true;
    } catch (e) {
      this.log(`听写启动失败: ${(e as Error).message}`);
      await this.cancel();
      return false;
    } finally { this.starting = false; }
  }

  /** Stops the capturer and sends speech.dictation.finish; the final transcript, if any, reaches onTranscript. */
  async stop(): Promise<void> {
    this.generation++;
    let dictationId = this.activeId;
    let rpc = this.rpc;
    this.running = false;
    this.onVolume(0);
    await this.closeCapturer();
    if (rpc !== null && dictationId.length > 0) {
      if (this.pending.length > 0) {
        this.enqueueChunk(dictationId, rpc, this.pending);
        this.pending = new Uint8Array(0);
      }
      await this.sendChain;
      try {
        let params: Record<string, string> = { 'dictationId': dictationId };
        let response: RpcResponse = await rpc.request('speech.dictation.finish',
          JSON.stringify(params));
        if (response instanceof RpcSuccess) {
          this.noteTranscript(response.result);
          this.log('dictation.finish 完成');
        } else {
          this.log(`dictation.finish 失败: ${(response as RpcFailure).errorMessage}`);
        }
      } catch (e) {
        this.log(`dictation.finish 异常: ${(e as Error).message}`);
      }
    }
    this.activeId = '';
    this.rpc = null;
  }

  /** Stops the capturer and sends speech.dictation.cancel; failures are logged and ignored (upstream skip policy). */
  async cancel(): Promise<void> {
    this.generation++;
    let dictationId = this.activeId;
    this.activeId = '';
    this.pending = new Uint8Array(0);
    let rpc = this.rpc;
    this.running = false;
    this.onVolume(0);
    await this.closeCapturer();
    if (rpc !== null && dictationId.length > 0) {
      try {
        let params: Record<string, string> = { 'dictationId': dictationId };
        await rpc.request('speech.dictation.cancel', JSON.stringify(params));
        this.log('dictation.cancel 已发送');
      } catch (e) {
        this.log(`dictation.cancel 异常（忽略）: ${(e as Error).message}`);
      }
    }
    this.activeId = '';
    this.rpc = null;
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  private async ensureMicPermission(): Promise<boolean> {
    try {
      let atManager = abilityAccessCtrl.createAtManager();
      let permissions: Array<Permissions> = ['ohos.permission.MICROPHONE'];
      let result = await atManager.requestPermissionsFromUser(this.context, permissions);
      for (let i = 0; i < result.authResults.length; i++) {
        if (result.authResults[i] === 0) {
          return true;
        }
      }
      return false;
    } catch (e) {
      this.log(`权限请求异常: ${(e as Error).message}`);
      return false;
    }
  }

  private async startCapturer(dictationId: string, rpc: SpikeRpcClient, generation: number): Promise<void> {
    let streamInfo: audio.AudioStreamInfo = {
      samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
      channels: audio.AudioChannel.CHANNEL_1,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    };
    let capturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_MIC,
      capturerFlags: 0
    };
    let options: audio.AudioCapturerOptions = {
      streamInfo: streamInfo,
      capturerInfo: capturerInfo
    };
    let capturer = await audio.createAudioCapturer(options);
    if (generation !== this.generation) { await capturer.release(); throw new Error('Capture cancelled'); }
    this.capturer = capturer;
    capturer.on('readData', (data: ArrayBuffer): void => {
      try {
        this.onReadData(dictationId, rpc, data);
      } catch (e) {
        this.log(`readData 处理异常: ${(e as Error).message}`);
      }
    });
    this.running = true;
    await capturer.start();
    if (generation !== this.generation || !this.running) { await this.closeCapturer(); throw new Error('Capture cancelled'); }
  }

  private async closeCapturer(): Promise<void> {
    let capturer = this.capturer;
    this.capturer = null;
    if (capturer === null) {
      return;
    }
    try {
      capturer.off('readData');
      await capturer.stop();
    } catch (e) {
      this.log(`停止麦克风异常: ${(e as Error).message}`);
    } finally {
      try { await capturer.release(); this.log('麦克风已关闭'); }
      catch (e) { this.log(`释放麦克风异常: ${(e as Error).message}`); }
    }
  }

  /** Runs on the audio callback thread: meter volume, buffer, emit fixed-size chunks. */
  private onReadData(dictationId: string, rpc: SpikeRpcClient, data: ArrayBuffer): void {
    if (!this.running || dictationId !== this.activeId || data.byteLength <= 0) {
      return;
    }
    let incoming = new Uint8Array(data);
    // Int16 LE peak, normalized to 0..1 for the UI meter.
    let view = new DataView(incoming.buffer, incoming.byteOffset, incoming.byteLength);
    let frames = Math.floor(incoming.byteLength / 2);
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let sample = view.getInt16(i * 2, true);
      let magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    this.onVolume(peak / PCM_INT16_MAX);
    // Accumulate and emit CHUNK_BYTES-sized chunks; copies guard against buffer reuse.
    let merged = new Uint8Array(this.pending.length + incoming.length);
    merged.set(this.pending, 0);
    merged.set(incoming, this.pending.length);
    this.pending = merged;
    while (this.pending.length >= CHUNK_BYTES) {
      let chunk = this.pending.slice(0, CHUNK_BYTES);
      this.pending = this.pending.slice(CHUNK_BYTES);
      this.enqueueChunk(dictationId, rpc, chunk);
    }
  }

  private enqueueChunk(dictationId: string, rpc: SpikeRpcClient, chunk: Uint8Array): void {
    if (dictationId !== this.activeId) { return; }
    if (this.queuedBytes + chunk.length > 320000) {
      this.log('听写发送积压，已停止采集，请检查网络后重试'); this.cancel().catch((): void => {}); return;
    }
    this.queuedBytes += chunk.length;
    let seq = this.seq;
    this.seq = seq + 1;
    this.sendChain = this.sendChain
      .then((): Promise<void> => this.sendChunkRpc(dictationId, rpc, chunk, seq))
      .catch((err: BusinessError): void => {
        this.log(`chunk #${seq} 发送链异常: ${err.message}`);
      }).finally((): void => {
        if (this.activeId === dictationId) { this.queuedBytes = Math.max(0, this.queuedBytes - chunk.length); }
      });
  }

  private async sendChunkRpc(dictationId: string, rpc: SpikeRpcClient,
    chunk: Uint8Array, seq: number): Promise<void> {
    if (dictationId !== this.activeId) {
      return;
    }
    let audioBase64 = new util.Base64Helper().encodeToStringSync(chunk);
    let params: Record<string, Object> = {
      'dictationId': dictationId,
      'audioBase64': audioBase64,
      'sampleRate': DICTATION_SAMPLE_RATE,
      'seq': seq
    };
    let response: RpcResponse = await rpc.request('speech.dictation.chunk',
      JSON.stringify(params));
    if (response instanceof RpcSuccess) {
      // Newer hosts return partial text on chunk replies; loose-read it when present.
      this.noteTranscript(response.result);
    } else {
      this.log(`chunk #${seq} 失败: ${(response as RpcFailure).errorMessage}`);
    }
  }

  /** result JSON may be {"text":"...","revision":n} (chunk) or carry final text (finish); anything else is ignored. */
  private noteTranscript(resultJson: string): void {
    try {
      if (this.onTranscript === null || resultJson.length === 0) {
        return;
      }
      let parsed: Object | null = JSON.parse(resultJson) as Object | null;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      let rec = parsed as Record<string, Object>;
      let textValue: Object = rec['text'];
      if (typeof textValue === 'string' && textValue.length > 0) {
        this.onTranscript(textValue);
      }
    } catch (e) {
      // Transcript is best-effort; chunk replies without text are normal on older hosts.
    }
  }
}
