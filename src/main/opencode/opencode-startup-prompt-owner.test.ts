import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../runtime/terminal-run-facts'
import {
  reserveOpenCodeStartupPrompt,
  commitPtyWithOpenCodePromptIntent
} from './opencode-startup-prompt-owner'

const control = vi.hoisted(() => ({
  claim: (_body: unknown): boolean | 'pending' => false,
  clear: () => {}
}))
const ownership = vi.hoisted(() => ({
  ptyOwnership: new Map<string, string>(),
  ptyIncarnationById: new Map<string, string>()
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    setStartupPromptClaimListener: (claim: typeof control.claim, clear: () => void) => {
      control.claim = claim
      control.clear = clear
    }
  }
}))
vi.mock('../ipc/pty/provider/ownership-state', () => ownership)
beforeEach(() => {
  control.clear()
  ownership.ptyOwnership.clear()
  ownership.ptyIncarnationById.clear()
})

function fixture() {
  const facts = new TerminalRunFactsRegister()
  const result = { id: 'owned', incarnationId: 'incarnation' }
  let identityReady = false
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = {
    terminalRunFacts: facts,
    readOpenCodeStartupPromptOwner: () =>
      identityReady ? facts.read(result.id, result.incarnationId) : ('pending' as const),
    isPtyStopRequested: () => false,
    subscribeToPtyExit: (_ptyId: string, _listener: () => void) => () => {}
  }
  ownership.ptyOwnership.set(result.id, 'local')
  ownership.ptyIncarnationById.set(result.id, result.incarnationId)
  const context = {
    env: {
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'nonce',
      ORCA_OPENCODE_STARTUP_PROMPT_SHA256: 'digest',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch'
    },
    deps: { runtime },
    result,
    provider: { hasPty: () => true },
    args: {}
  }
  reserveOpenCodeStartupPrompt('nonce', 'digest')
  const body = { nonce: 'nonce', digest: 'digest' }
  return {
    facts,
    result,
    context,
    waiting,
    release,
    body,
    admit: () => {
      identityReady = true
    }
  }
}

describe('native prompt admission after spawn commit', () => {
  it('waits through delayed persistence and later runtime identity admission', async () => {
    const f = fixture()
    const committed = commitPtyWithOpenCodePromptIntent(f.context, async () => {
      await f.waiting
      f.facts.recordSpawnCommit(f.result)
      return f.result
    })
    expect(control.claim(f.body)).toBe('pending')
    f.release()
    await committed
    expect(control.claim(f.body)).toBe('pending')
    f.admit()
    expect(control.claim(f.body)).toBe(true)
    expect(control.claim(f.body)).toBe(false)
  })

  it('keeps pre-commit driving input sticky even if the draft is erased', async () => {
    const f = fixture()
    const committed = commitPtyWithOpenCodePromptIntent(f.context, async () => {
      await f.waiting
      f.facts.recordSpawnCommit(f.result)
      return f.result
    })
    f.facts.recordInput(f.result.id, 'driving', 'x')
    f.facts.recordInput(f.result.id, 'driving', '\u007f')
    expect(control.claim(f.body)).toBe('pending')
    f.release()
    await committed
    f.admit()
    expect(control.claim(f.body)).toBe(false)
  })

  it('cancels a failed commit without allowing later admission', async () => {
    const f = fixture()
    await expect(
      commitPtyWithOpenCodePromptIntent(f.context, async () => {
        throw new Error('persistence rejected')
      })
    ).rejects.toThrow('persistence rejected')
    f.admit()
    expect(control.claim(f.body)).toBe(false)
  })
  it.each(['incarnation', 'provider', 'stop', 'exit', 'clear'])(
    'invalidates granted replay after %s',
    async (reason) => {
      const f = fixture()
      let exited = () => {}
      const unsubscribe = vi.fn()
      vi.spyOn(f.context.deps.runtime, 'subscribeToPtyExit').mockImplementation(
        (_id, listener: () => void) => {
          exited = listener
          return unsubscribe
        }
      )
      await commitPtyWithOpenCodePromptIntent(f.context, async () => {
        f.facts.recordSpawnCommit(f.result)
        return f.result
      })
      f.admit()
      const body = { ...f.body, requestId: 'stable-operation' }
      expect(control.claim(body)).toBe(true)
      expect(control.claim(body)).toBe(true)
      if (reason === 'incarnation') {
        ownership.ptyIncarnationById.set(f.result.id, 'replacement')
      }
      if (reason === 'provider') {
        vi.spyOn(f.context.provider, 'hasPty').mockReturnValue(false)
      }
      if (reason === 'stop') {
        vi.spyOn(f.context.deps.runtime, 'isPtyStopRequested').mockReturnValue(true)
      }
      if (reason === 'exit') {
        exited()
      }
      if (reason === 'clear') {
        control.clear()
      }
      expect(control.claim(body)).toBe(false)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      f.facts.recordSpawnCommit(f.result)
      expect(control.claim(body)).toBe(false)
    }
  )

  it('retains sticky input cancellation after a lost grant response', async () => {
    const f = fixture()
    await commitPtyWithOpenCodePromptIntent(f.context, async () => {
      f.facts.recordSpawnCommit(f.result)
      return f.result
    })
    f.admit()
    const body = { ...f.body, requestId: 'stable-operation' }
    expect(control.claim(body)).toBe(true)
    f.facts.recordInput(f.result.id, 'driving', 'x')
    f.facts.recordInput(f.result.id, 'driving', '\u007f')
    expect(control.claim(body)).toBe(false)
  })
})
