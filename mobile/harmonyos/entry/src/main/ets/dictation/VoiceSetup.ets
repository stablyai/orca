import { RpcSuccess, SpikeRpcClient } from '../transport/SpikeRpcClient';
import upstream from '../vendor/dictation-shortcut-mode.js';

export interface SpeechModel {
  id: string;
  label: string;
  provider: string;
  status: string;
  sizeBytes: number;
  progress: number | null;
  recommended: boolean;
}

export interface VoiceSetup {
  enabled: boolean;
  dictationMode: string;
  dictationHoldToRecord?: boolean;
  selectedModelId: string;
  models: SpeechModel[];
}

export interface VoiceConfig {
  enabled?: boolean;
  dictationMode?: string;
  dictationHoldToRecord?: boolean;
  modelId?: string;
}

export function modelInFlight(model: SpeechModel): boolean {
  return model.status === 'downloading' || model.status === 'extracting';
}

const shortcut: ESObject = upstream;

export function voiceShortcutMode(setup: VoiceSetup | null): string {
  if (!setup) { return ''; }
  return setup.dictationHoldToRecord === undefined ? setup.dictationMode : shortcut.dictationShortcutMode(setup) as string;
}

export function voiceShortcutModeConfig(mode: string): VoiceConfig {
  return shortcut.dictationShortcutModeSettings(mode) as VoiceConfig;
}

function readSetup(payload: string): VoiceSetup {
  let record = JSON.parse(payload) as Record<string, Object>;
  if (!record || !Array.isArray(record['models'])) { throw new Error('Invalid voice setup'); }
  let models: SpeechModel[] = [];
  let ids = new Set<string>();
  for (let item of (record['models'] as Object[])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { continue; }
    let row = item as Record<string, Object>;
    let id = row['id'];
    if (typeof id !== 'string' || !id || ids.has(id)) { continue; }
    ids.add(id);
    let size = row['sizeBytes']; let progress = row['progress'];
    models.push({
      id: id,
      label: typeof row['label'] === 'string' ? row['label'] as string : id,
      provider: typeof row['provider'] === 'string' ? row['provider'] as string : '',
      status: typeof row['status'] === 'string' ? row['status'] as string : '',
      sizeBytes: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0,
      progress: typeof progress === 'number' && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null,
      recommended: row['recommended'] === true
    });
  }
  return {
    enabled: record['enabled'] === true,
    dictationMode: typeof record['dictationMode'] === 'string' ? record['dictationMode'] as string : '',
    dictationHoldToRecord: typeof record['dictationHoldToRecord'] === 'boolean' ? record['dictationHoldToRecord'] as boolean : undefined,
    selectedModelId: typeof record['selectedModelId'] === 'string' ? record['selectedModelId'] as string : '',
    models: models
  };
}

export class VoiceSettingsRpc {
  private client: SpikeRpcClient;

  constructor(client: SpikeRpcClient) { this.client = client; }

  private async call(method: string, params: string | null): Promise<string> {
    let reply = await this.client.request(method, params);
    if (reply instanceof RpcSuccess) { return reply.result; }
    if (reply.errorCode === 'method_not_found' || reply.errorMessage.includes('not available to mobile clients')) {
      throw new Error('更新已配对桌面的 Orca 后即可管理语音设置。');
    }
    if (reply.errorMessage.startsWith('speech_unavailable')) {
      throw new Error('更新此服务器上的 Orca 后即可使用语音听写。');
    }
    throw new Error('');
  }

  async load(): Promise<VoiceSetup> { return readSetup(await this.call('speech.models.list', null)); }
  async configure(params: VoiceConfig): Promise<VoiceSetup> {
    return readSetup(await this.call('speech.dictation.setup', JSON.stringify(params)));
  }
  async download(modelId: string): Promise<void> {
    await this.call('speech.models.download', JSON.stringify({ modelId: modelId }));
  }
  async delete(modelId: string): Promise<VoiceSetup> {
    return readSetup(await this.call('speech.models.delete', JSON.stringify({ modelId: modelId })));
  }
}
