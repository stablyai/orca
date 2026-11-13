import { speechRecognizer } from '@kit.CoreSpeechKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { getString, KEY_DICTATION_ENGINE } from '../settings/SettingsStore';

export class NativeSpeech {
  private engine: speechRecognizer.SpeechRecognitionEngine | null = null;
  private context: common.UIAbilityContext;
  private sessionId = '';
  private generation = 0;
  private sequence = 0;
  private revision = 0;
  private committed = '';
  private tentative = '';
  private failure: string | null = 'failed';
  private pending = new Uint8Array(0);
  private starting: ((ready: boolean) => void) | null = null;
  private finishing: ((ready: boolean) => void) | null = null;
  private finalizing: Promise<void> | null = null;
  private closed = false;
  private opening: Promise<speechRecognizer.SpeechRecognitionEngine | null> | null = null;
  private startRequested = false;
  private isActive: () => boolean;

  constructor(context: common.UIAbilityContext, isActive: () => boolean = (): boolean => true) {
    this.context = context; this.isActive = isActive;
  }

  canCapture(): boolean {
    return !this.closed && this.isActive() && this.sessionId.length > 0 && !this.starting && !this.finalizing && !this.failure;
  }

  private async engineFor(locale: string): Promise<speechRecognizer.SpeechRecognitionEngine | null> {
    if (!/^zh(?:-Hans)?(?:-CN)?$/i.test(locale) || !canIUse('SystemCapability.AI.SpeechRecognizer')) { return null; }
    if (this.engine) { return this.engine; }
    if (this.opening) { return this.opening; }
    let opening = this.openEngine(); this.opening = opening;
    try { return await opening; } finally { if (this.opening === opening) { this.opening = null; } }
  }

  private async openEngine(): Promise<speechRecognizer.SpeechRecognitionEngine | null> {
    let generation = this.generation;
    let engine = await speechRecognizer.createEngine({ language: 'zh-CN', online: 1,
      extraParams: { recognizerMode: 'long' } });
    if (this.closed || generation !== this.generation || !this.isActive()) { engine.shutdown(); return null; }
    engine.setListener({
      onStart: (id: string): void => {
        if (id === this.sessionId && this.starting) { let done = this.starting; this.starting = null; done(true); }
      },
      onEvent: (): void => {},
      onResult: (id: string, result: speechRecognizer.SpeechRecognitionResult): void => {
        if (id !== this.sessionId) { return; }
        let text = result.result.slice(0, 64000 - this.committed.length);
        if (result.isFinal) { this.committed += text; this.tentative = ''; }
        else { this.tentative = text; }
        this.revision++;
      },
      onComplete: (id: string): void => {
        if (id !== this.sessionId) { return; }
        if (this.finishing) { let done = this.finishing; this.finishing = null; done(true); }
        this.sessionId = '';
      },
      onError: (id: string): void => {
        if (id !== this.sessionId) { return; }
        this.failure = 'failed';
        if (this.starting) { let done = this.starting; this.starting = null; done(false); }
        if (this.finishing) { let done = this.finishing; this.finishing = null; done(false); }
        this.sessionId = '';
      }
    });
    this.engine = engine;
    return engine;
  }

  async serve(value: ESObject): Promise<ESObject> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid speech parameters'); }
    let action: string = value['action'];
    let needsLocale = action === 'status' || action === 'start';
    let keys = Object.keys(value);
    if (keys.length !== (needsLocale ? 2 : 1) || !keys.every((key: string): boolean => ['action', 'locale'].includes(key))
      || !['status', 'start', 'read', 'finish', 'cancel'].includes(action)) { throw new Error('Invalid speech parameters'); }
    if (needsLocale && (typeof value['locale'] !== 'string' || value['locale'].length < 1 || value['locale'].length > 35)) {
      throw new Error('Invalid speech locale');
    }
    if (action === 'cancel') { this.cancel(); return {}; }
    if (action === 'read') { return { revision: this.revision, committed: this.committed, tentative: this.tentative, failure: this.failure }; }
    if (action === 'finish') { return this.finish(); }
    if (this.closed || !this.isActive()) { throw new Error('Speech session closed'); }
    if (action === 'start' && (this.startRequested || this.finalizing)) {
      return { started: false, locale: null, reason: 'busy' };
    }
    if (action === 'start') { this.startRequested = true; }
    let requestGeneration = this.generation;
    let engine: speechRecognizer.SpeechRecognitionEngine | null = null;
    let status = 'unsupported';
    try { engine = await this.engineFor(value['locale']); status = engine ? engine.isBusy() ? 'busy' : 'ready' : 'unsupported'; }
    catch (e) {
      let code = (e as BusinessError).code;
      status = code === 1002200006 || code === 1002200008 ? 'busy' : 'unsupported';
    }
    if (action === 'status') {
      return { status: status, locale: engine ? 'zh-CN' : null, preference: await getString(this.context, KEY_DICTATION_ENGINE) };
    }
    if (this.closed || requestGeneration !== this.generation || !this.isActive()) { this.startRequested = false; return { started: false, locale: null, reason: 'failed' }; }
    if (this.sessionId.length > 0 || !engine || status !== 'ready') {
      this.startRequested = false;
      return { started: false, locale: engine ? 'zh-CN' : null, reason: status === 'ready' ? 'busy' : status };
    }
    this.sequence++; this.sessionId = `speech-${this.sequence}`; let id = this.sessionId;
    this.committed = ''; this.tentative = ''; this.failure = null; this.revision = 0; this.pending = new Uint8Array(0);
    let ready = await new Promise<boolean>((resolve: (value: boolean) => void): void => {
      let timer = setTimeout((): void => { this.starting = null; resolve(false); }, 3000);
      this.starting = (success: boolean): void => { clearTimeout(timer); resolve(success); };
      try {
        engine!.startListening({ sessionId: this.sessionId,
          audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 } });
      } catch (e) { this.starting(false); this.starting = null; }
    });
    this.startRequested = false;
    let started = ready && this.isActive() && requestGeneration === this.generation && this.sessionId === id;
    if (!started && this.sessionId === id) { this.cancel(); }
    return { started: started, locale: 'zh-CN', reason: started ? null : 'failed' };
  }

  feed(bytes: Uint8Array): void {
    if (!this.engine || this.sessionId.length === 0 || this.failure || this.starting || this.finalizing) { return; }
    let samples = new Uint8Array(this.pending.length + bytes.length);
    samples.set(this.pending); samples.set(bytes, this.pending.length);
    let offset = 0;
    try {
      while (offset + 640 <= samples.length) { this.engine.writeAudio(this.sessionId, samples.slice(offset, offset + 640)); offset += 640; }
      this.pending = samples.slice(offset);
    } catch (e) { this.failure = 'failed'; this.pending = new Uint8Array(0); }
  }

  private async finish(): Promise<ESObject> {
    let generation = this.generation;
    this.endInput();
    await this.finalizing;
    if (generation !== this.generation) { return { text: null, failure: 'failed' }; }
    this.finalizing = null;
    return this.takeTranscript();
  }

  endInput(): void {
    if (this.engine && this.sessionId.length > 0 && !this.starting && !this.finalizing) {
      this.finalizing = this.finalize(this.engine, this.sessionId);
    }
  }

  private async finalize(engine: speechRecognizer.SpeechRecognitionEngine, id: string): Promise<void> {
    let generation = this.generation;
    if (this.pending.length > 0) {
      let tail = new Uint8Array(640); tail.set(this.pending); this.pending = new Uint8Array(0);
      try { engine.writeAudio(id, tail); } catch (e) { this.failure = 'failed'; }
    }
    let complete = await new Promise<boolean>((resolve: (value: boolean) => void): void => {
      let timer = setTimeout((): void => { this.finishing = null; resolve(false); }, 5000);
      this.finishing = (success: boolean): void => { clearTimeout(timer); resolve(success); };
      try { engine.finish(id); } catch (e) { this.finishing(false); this.finishing = null; }
    });
    if (generation === this.generation && !complete && this.sessionId === id) { this.cancel(); }
  }

  private clearTranscript(): void {
    this.committed = ''; this.tentative = ''; this.revision = 0; this.failure = 'failed';
  }

  private takeTranscript(): ESObject {
    let result: ESObject = { text: this.failure ? null : this.committed, failure: this.failure };
    this.clearTranscript();
    return result;
  }

  cancel(): void {
    this.generation++;
    this.finalizing = null;
    let id = this.sessionId; this.sessionId = '';
    if (this.engine && id.length > 0) { try { this.engine.cancel(id); } catch (e) { } }
    this.pending = new Uint8Array(0);
    this.clearTranscript();
    if (this.starting) { let done = this.starting; this.starting = null; done(false); }
    if (this.finishing) { let done = this.finishing; this.finishing = null; done(false); }
  }

  dispose(): void {
    this.closed = true; this.cancel();
    if (this.engine) { try { this.engine.shutdown(); } catch (e) { } this.engine = null; }
  }
}
