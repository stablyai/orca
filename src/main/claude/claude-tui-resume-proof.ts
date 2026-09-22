import { posix, win32 } from 'node:path'

export type ClaudeTuiSessionStartEvidence = {
  hookEventName: 'SessionStart'
  source: 'resume'
  sessionId: string
  transcriptPath: string
  launchToken: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function hookPayload(envelope: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof envelope.payload === 'string') {
    try {
      return record(JSON.parse(envelope.payload))
    } catch {
      return null
    }
  }
  return record(envelope.payload) ?? envelope
}

export function readClaudeTuiSessionStartEvidence(
  value: unknown
): ClaudeTuiSessionStartEvidence | null {
  const envelope = record(value)
  if (!envelope) {
    return null
  }
  const payload = hookPayload(envelope)
  if (!payload) {
    return null
  }
  const hookEventName = nonEmptyString(payload.hook_event_name ?? payload.hookEventName)
  const source = nonEmptyString(payload.source)
  const sessionId = nonEmptyString(payload.session_id ?? payload.sessionId)
  const transcriptPath = nonEmptyString(payload.transcript_path ?? payload.transcriptPath)
  const launchToken = nonEmptyString(envelope.launchToken ?? payload.launchToken)
  return hookEventName === 'SessionStart' &&
    source === 'resume' &&
    sessionId &&
    transcriptPath &&
    launchToken
    ? { hookEventName, source, sessionId, transcriptPath, launchToken }
    : null
}

function comparablePath(value: string, platform: NodeJS.Platform): string | null {
  if (value.includes('\0')) {
    return null
  }
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(value)) {
    return null
  }
  const normalized = path.normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function proveClaudeTuiResume(input: {
  expectedSessionId: string
  expectedTranscriptPath: string
  expectedLaunchToken: string
  waitForSessionStart: () => Promise<unknown>
  timeoutMs?: number
  platform?: NodeJS.Platform
}): Promise<ClaudeTuiSessionStartEvidence> {
  const timeoutMs = input.timeoutMs ?? 15_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const evidence = readClaudeTuiSessionStartEvidence(
      await Promise.race([
        input.waitForSessionStart(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('The agent terminal did not prove the expected Claude resume.')),
            timeoutMs
          )
          timer.unref?.()
        })
      ])
    )
    if (!evidence) {
      throw new Error('The agent terminal did not emit a Claude resume SessionStart proof.')
    }
    if (evidence.launchToken !== input.expectedLaunchToken) {
      throw new Error('The Claude resume proof came from a different launched process.')
    }
    if (evidence.sessionId !== input.expectedSessionId) {
      throw new Error('The agent terminal resumed a different Claude session.')
    }
    const platform = input.platform ?? process.platform
    const expectedPath = comparablePath(input.expectedTranscriptPath, platform)
    const observedPath = comparablePath(evidence.transcriptPath, platform)
    if (!expectedPath || !observedPath || observedPath !== expectedPath) {
      throw new Error('The agent terminal resumed a different Claude transcript.')
    }
    return evidence
  } finally {
    clearTimeout(timer)
  }
}
