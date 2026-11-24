import { describe, expect, it } from 'vitest'
import {
  CodexAccountRestartResumeUnavailableError,
  resolveCodexAccountRestartResume
} from './codex-account-restart-resume-gate'
import {
  CodexAccountRestartStops,
  type CodexRestartStopOutcome
} from './codex-account-restart-stops'

const ORIGINAL_TRANSCRIPT = '/old-home/sessions/2026/11/01/rollout-2026-11-01-thread-1.jsonl'
const SELECTED_HOME_COPY = '/new-home/sessions/2026/11/01/rollout-2026-11-01-thread-1.jsonl'
const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf' }

function admitStop(stops: CodexAccountRestartStops, outcome: CodexRestartStopOutcome = 'ended') {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = stops.request(
    { ...pane, ptyId: 'pty-a', opId: 'op-1' },
    {
      resolveOccupant: () => ({
        ptyId: 'pty-a',
        incarnationId: 'inc-a',
        provenance: { threadId: 'thread-1', transcriptPath: ORIGINAL_TRANSCRIPT }
      }),
      stop: async () => {
        await held
        return outcome
      }
    }
  )
  return { result, release }
}

function resume(
  stops: CodexAccountRestartStops,
  overrides: Partial<Parameters<typeof resolveCodexAccountRestartResume>[0]> = {}
) {
  return resolveCodexAccountRestartResume(
    {
      launchAgent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'thread-1' },
      ...pane,
      preAdopted: false,
      replacesPtyId: undefined,
      connectionId: null,
      selectionRuntime: 'host',
      isDaemonHostSpawn: true,
      ...overrides
    },
    stops
  )
}

describe('account restart resume reopens the exact conversation', () => {
  it('resumes the captured transcript on the selected account, never another home copy', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const decision = await resume(stops, {
      resumeProviderSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: SELECTED_HOME_COPY
      }
    })
    expect(decision.resumeOnSelectedAccount).toBe(true)
    expect(decision.providerSession).toEqual({
      key: 'session_id',
      id: 'thread-1',
      transcriptPath: ORIGINAL_TRANSCRIPT
    })
  })

  it('waits for the stop to settle before deciding the account', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    let decided = false
    const decision = resume(stops).then((value) => {
      decided = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(decided).toBe(false)
    release()
    await result
    await expect(decision).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('never lends the switch to a different thread, and keeps it for the right one', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const other = await resume(stops, {
      resumeProviderSession: { key: 'session_id', id: 'thread-2', transcriptPath: '/x.jsonl' }
    })
    expect(other).toEqual({
      providerSession: { key: 'session_id', id: 'thread-2', transcriptPath: '/x.jsonl' },
      resumeOnSelectedAccount: false
    })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('spends the intent once; a failed launch puts it back for the next resume', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const first = await resume(stops)
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: false })
    first.unspend?.()
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('leaves the intent unspent across an exact reattach', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    await expect(resume(stops, { preAdopted: true })).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('resumes pinned without writer proof', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops, 'unknown')
    release()
    await expect(result).resolves.toMatchObject({ outcome: 'unknown' })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: false })
  })

  it('fails explicitly when the route changed after the stop', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    await expect(resume(stops, { isDaemonHostSpawn: false })).rejects.toBeInstanceOf(
      CodexAccountRestartResumeUnavailableError
    )
    // The failed launch keeps the intent for the next resume on a capable route.
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('fails once instead of opening a shell when the stopped pane returns without its conversation', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const withoutConversation = { launchAgent: undefined, resumeProviderSession: undefined }
    await expect(resume(stops, withoutConversation)).rejects.toBeInstanceOf(
      CodexAccountRestartResumeUnavailableError
    )
    // Restarting the pane afterwards is an ordinary start.
    await expect(resume(stops, withoutConversation)).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
  })

  it('opens the shell normally when the stop was Dismissed, unproven or never made', async () => {
    const unproven = new CodexAccountRestartStops()
    const stop = admitStop(unproven, 'unknown')
    stop.release()
    await stop.result
    const withoutConversation = { launchAgent: undefined, resumeProviderSession: undefined }
    await expect(resume(unproven, withoutConversation)).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
    await expect(
      resume(new CodexAccountRestartStops(), withoutConversation)
    ).resolves.toMatchObject({ resumeOnSelectedAccount: false })
  })

  it('after main loss resumes exactly the recorded transcript on the old account', async () => {
    // A fresh register stands for main after a restart: the in-memory intent is gone.
    const decision = await resume(new CodexAccountRestartStops(), {
      resumeProviderSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: ORIGINAL_TRANSCRIPT
      }
    })
    expect(decision).toEqual({
      providerSession: { key: 'session_id', id: 'thread-1', transcriptPath: ORIGINAL_TRANSCRIPT },
      resumeOnSelectedAccount: false
    })
  })
})
