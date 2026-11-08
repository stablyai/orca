import { StringDecoder } from 'node:string_decoder'
import { readIndexedCodexThreadProvider } from '../index/codex-state-db'
import { readCodexRolloutBytes } from '../../../native-chat/codex-rollout-history-stream'
import { asRecord } from '../../../ai-vault/session-scanner-record-value'

export async function readCodexSessionResumeProvider(args: {
  sessionId: string
  homePath: string
  transcriptPath: string
}): Promise<string | null> {
  const indexed = readIndexedCodexThreadProvider(args.homePath, args.sessionId)
  const rolloutProvider = await readEffectiveRolloutProvider(args.transcriptPath, args.sessionId)
  if (indexed && rolloutProvider && indexed !== rolloutProvider) {
    throw new Error('Codex resume stopped: the session index and rollout model providers disagree')
  }
  const provider = indexed ?? rolloutProvider
  if (provider && !/^[A-Za-z0-9_.-]+$/.test(provider)) {
    throw new Error('Codex resume stopped: the saved model provider could not be verified')
  }
  return provider
}

async function readEffectiveRolloutProvider(
  filePath: string,
  sessionId: string
): Promise<string | null> {
  let provider: string | null = null
  let verifiedIdentity = false
  let pending = ''
  const decoder = new StringDecoder('utf8')
  const apply = (line: string): void => {
    if (
      verifiedIdentity &&
      !line.includes('thread_settings_applied') &&
      !line.includes('session_meta')
    ) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('Codex resume stopped: the saved rollout could not be decoded')
    }
    const record = asRecord(parsed)
    if (!record) {
      throw new Error('Codex resume stopped: the saved rollout could not be decoded')
    }
    const payload = asRecord(record.payload)
    const id =
      payload?.id ??
      payload?.session_id ??
      payload?.thread_id ??
      record.id ??
      record.session_id ??
      record.thread_id
    const canonical = typeof id === 'string' && id.toLowerCase() === sessionId.toLowerCase()
    if (!verifiedIdentity) {
      if (record.type !== 'session_meta' || !canonical) {
        throw new Error('Codex resume stopped: the saved session identity could not be verified')
      }
      verifiedIdentity = true
    }
    if (record.type === 'session_meta') {
      const value = payload?.model_provider
      if (canonical && typeof value === 'string') {
        provider = value || null
      }
    } else if (record.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
      // Codex applies copied settings snapshots even when they retain their original thread_id.
      const value = asRecord(payload.thread_settings)?.model_provider_id
      if (typeof value !== 'string') {
        throw new Error(
          'Codex resume stopped: saved thread settings have no verifiable model provider'
        )
      }
      provider = value || null
    }
  }
  for await (const chunk of readCodexRolloutBytes(
    filePath,
    undefined,
    AbortSignal.timeout(5_000)
  )) {
    pending += decoder.write(chunk)
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      apply(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
  }
  pending += decoder.end()
  if (pending.trim()) {
    apply(pending)
  }
  if (!verifiedIdentity) {
    throw new Error('Codex resume stopped: the saved session identity could not be verified')
  }
  return provider
}
