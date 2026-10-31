import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMobileConflictRunners } from './use-mobile-conflict-runners'
import { mobileConflictNeedsNewerHostMessage } from './mobile-source-control-conflict-actions'

type Runners = ReturnType<typeof useMobileConflictRunners>

// Records what the shared workflow would show: the error a step throws, or none.
async function run(
  sendGitRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  act_: (runners: Runners) => Promise<void>
): Promise<string | null> {
  let shown: string | null = null
  let runners: Runners | null = null
  function Harness(): null {
    runners = useMobileConflictRunners({
      sendGitRequest,
      runGitAction: async () => true,
      runGitWorkflow: async (_id, step) => {
        try {
          await step()
          return true
        } catch (err) {
          shown = err instanceof Error ? err.message : String(err)
          return false
        }
      }
    })
    return null
  }
  await act(async () => {
    create(createElement(Harness))
  })
  await act(async () => {
    if (runners) {
      await act_(runners)
    }
  })
  return shown
}

const goneRow = { path: 'gone.txt', resolveActionId: 'resolve:gone.txt' }

describe('useMobileConflictRunners', () => {
  it('sends the chosen resolution for the row to the host', async () => {
    const sendGitRequest = vi.fn(async () => ({ ok: true }))
    const shown = await run(sendGitRequest, (r) => r.resolveConflict(goneRow, 'keep_deletion'))
    expect(shown).toBeNull()
    expect(sendGitRequest).toHaveBeenCalledWith('git.resolveConflict', {
      filePath: 'gone.txt',
      resolution: 'keep_deletion'
    })
  })

  it('shows Git’s refusal when the host reports Complete merge failed in its reply', async () => {
    const sendGitRequest = vi.fn(async () => ({
      success: false,
      error: 'Committing is not possible because you have unmerged files.'
    }))
    const shown = await run(sendGitRequest, (r) => r.completeMerge())
    expect(shown).toBe('Committing is not possible because you have unmerged files.')
  })

  it('asks for a desktop update when an older host refuses the new methods', async () => {
    const refusal = Object.assign(
      new Error('Method git.completeMerge is not available to mobile clients'),
      {
        code: 'forbidden'
      }
    )
    const shown = await run(
      vi.fn(async () => {
        throw refusal
      }),
      (r) => r.completeMerge()
    )
    expect(shown).toBe(mobileConflictNeedsNewerHostMessage())
  })
})
