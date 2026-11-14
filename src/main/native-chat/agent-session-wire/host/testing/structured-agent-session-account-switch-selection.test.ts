import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentSessionAccountHomesEqual } from '../../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { ClaudeManagedAccount } from '../../../../../shared/managed-account-types'
import { createEmptyRateLimitState } from '../../../../../shared/rate-limit-state-factory'
import { claudeStateFile } from '../../../../claude-accounts/sign-in/claude-account-folder'
import {
  CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE,
  type ClaudeAccountSettings
} from '../../../../claude-accounts/selection/claude-account-selection'
import { moveChatsAfterClaudeAccountSelection } from '../../../../claude-accounts/selection/claude-account-switch-chat-moves'
import { getClaudeProfileRouter } from '../../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { ClaudeAccountService } from '../../../../claude-accounts/service'
import { reportedChildWork } from '../../observations/testing/structured-agent-session-reported-child-work.test-support'
import {
  createReceivingCallerFixture,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'
import {
  type AccountSwitchFixture,
  accountHome,
  chatOwingBackgroundTask,
  devServer,
  dispatchedTexts,
  MOVED_MESSAGE
} from './structured-agent-session-account-switch.test-support'

vi.mock('../../../../macos-keychain/generic-password', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readKeychainPassword: async () => null
}))

const savedAccount = (id: string): ClaudeManagedAccount => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth',
  managedAuthPath: '/unused',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
})

type Runtime = { sync: () => Promise<void>; removeFolder?: () => Promise<void> }

function claudeAccounts(f: AccountSwitchFixture, runtime: Runtime) {
  const settings: ClaudeAccountSettings = {
    claudeManagedAccounts: [savedAccount('a'), savedAccount('b'), savedAccount('c')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined
  }
  const router = getClaudeProfileRouter()!
  const stateFile = claudeStateFile(router.accountHome('b'))
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } }))
  writeFileSync(
    join(router.accountHome('b'), '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
  )
  const store = {
    getSettings: () => settings,
    updateSettings: (patch: Partial<ClaudeAccountSettings>) => {
      Object.assign(settings, patch)
      const selected = patch.activeClaudeManagedAccountId
      if (selected !== undefined) {
        f.select(selected === 'a' || selected === 'b' ? selected : null)
      }
    }
  }
  const usage = {
    evictInactiveClaudeCache() {},
    refreshForClaudeAccountChange: async () => createEmptyRateLimitState()
  }
  const service = new ClaudeAccountService(store, usage, {
    router,
    syncForCurrentSelection: runtime.sync,
    publishAll: async () => {},
    removeAccountFolder: runtime.removeFolder ?? (async () => {}),
    prepareAccountFolder: () => Promise.reject(new Error('no sign-in here')),
    getRuntimeConfigDir: () => router.systemDefaultHome()
  })
  const moves: Promise<void>[] = []
  service.setSelectionAppliedListener(() => {
    const moved = moveChatsAfterClaudeAccountSelection(() => ({
      claudeAccountSwitchRunningSessions: 'restart-all'
    }))
    moves.push(moved)
  })
  return { service, moves }
}

it('a selection whose sync fails moves no chat and sends nothing', async () => {
  const f = await createReceivingCallerFixture()
  const queued = Promise.withResolvers<void>()
  try {
    await chatOwingBackgroundTask(f)
    const { service, moves } = claudeAccounts(f, {
      sync: async () => {
        await queued.promise
        throw new Error('publishing the selection failed')
      }
    })
    const selected = service.selectAccount('b')
    setTimeout(queued.resolve, 200)
    await expect(selected).rejects.toThrow('publishing the selection failed')
    await Promise.all(moves)
    expect(f.launches).toEqual([accountHome(f, 'a')])
    expect(dispatchedTexts(f)).toEqual(['start the dev server'])
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeA)
  } finally {
    queued.resolve()
    await f.dispose()
  }
})

it('a selection in force moves the chat once its sync succeeds', async () => {
  const f = await createReceivingCallerFixture()
  try {
    await chatOwingBackgroundTask(f)
    const { service, moves } = claudeAccounts(f, {
      sync: async () => expect(moves).toHaveLength(0)
    })
    await service.selectAccount('b')
    await Promise.all(moves)
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['start the dev server', MOVED_MESSAGE])
  } finally {
    await f.dispose()
  }
})

it('removing the selected account starts its chat move after the sync, even while the folder is in use', async () => {
  const f = await createReceivingCallerFixture()
  const movesAtSync: number[] = []
  let removals = 0
  try {
    await chatOwingBackgroundTask(f)
    const { service, moves } = claudeAccounts(f, {
      sync: async () => {
        movesAtSync.push(moves.length)
      },
      removeFolder: async () => {
        const home = f.rig.host.childAccountHome(PARENT)
        const onA = home !== undefined && agentSessionAccountHomesEqual(home, f.homeA)
        removals += 1
        if (onA || removals === 1) {
          throw new Error('EBUSY: resource busy or locked')
        }
      }
    })
    await expect(service.removeAccount('a')).rejects.toThrow(CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE)
    await Promise.all(moves)
    expect(f.launches).toEqual([accountHome(f, 'a'), f.systemHome.path])
    expect(dispatchedTexts(f)).toEqual(['start the dev server', MOVED_MESSAGE])
    await service.removeAccount('a')
    await Promise.all(moves)
    expect(movesAtSync).toEqual([0, 1, 1])
  } finally {
    await f.dispose()
  }
})

it('removing an account and a selection queued behind it settle while the chat stop is held', async () => {
  const f = await createReceivingCallerFixture()
  const stopHeld = Promise.withResolvers<boolean>()
  try {
    await chatOwingBackgroundTask(f)
    f.rig.adapter.closeSession.mockImplementationOnce(() => stopHeld.promise)
    const { service, moves } = claudeAccounts(f, { sync: async () => {} })
    const settled: string[] = []
    const removed = service.removeAccount('a').then(() => settled.push('removed'))
    const selected = service.selectAccount('b').then(() => settled.push('selected'))
    await vi.waitFor(() => expect(f.rig.adapter.closeSession).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(settled).toEqual(['removed', 'selected']))
    stopHeld.resolve(true)
    await Promise.all([removed, selected, ...moves])
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
  } finally {
    stopHeld.resolve(true)
    await f.dispose()
  }
})

it('removing an account that is not selected leaves a chat on another account where it runs', async () => {
  const f = await createReceivingCallerFixture()
  try {
    f.select('b')
    await f.found()
    const id = await f.send('start the dev server')
    await f.turn(id, 'running')
    f.rig.host.publishChildWorkEvidence(PARENT, reportedChildWork([devServer], f.rig.clock.now))
    await f.turn(id, 'completed')
    f.select('a')
    const { service, moves } = claudeAccounts(f, { sync: async () => {} })
    await service.removeAccount('c')
    await Promise.all(moves)
    expect(f.launches).toEqual([accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual(['start the dev server'])
    expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
  } finally {
    await f.dispose()
  }
})
