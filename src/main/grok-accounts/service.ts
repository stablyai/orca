import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { runProcess } from '../../shared/child-process/run-process'
import type { GrokAccountsState } from '../../shared/grok-account-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { readGrokAuthSession } from '../rate-limits/grok-auth'
import { fetchGrokRateLimits } from '../rate-limits/grok-fetcher'
import { getGrokAccountsRoot, getOwnedGrokAccountHome, readGrokAccountIndex } from './paths'

let pendingLogin: AbortController | null = null

function createHome(id: string): string {
  const home = join(getGrokAccountsRoot(), id)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.orca-grok-account'), id, { mode: 0o600, flag: 'wx' })
  const config = join(resolveGrokHomeDir(), 'config.toml')
  if (existsSync(config)) {
    copyFileSync(config, join(home, 'config.toml'))
  }
  return home
}

export function captureGrokAccount(home: string, id: string): void {
  if (getOwnedGrokAccountHome(id) !== home) {
    throw new Error('Invalid Grok account folder')
  }
  const auth = readGrokAuthSession(home)
  if (auth.status !== 'ok' || !auth.session.userId || !auth.session.email) {
    throw new Error('Grok sign-in did not return an account identity')
  }
  const index = readGrokAccountIndex()
  if (
    index.accounts.some((a) => a.userId === auth.session.userId && a.teamId === auth.session.teamId)
  ) {
    throw new Error('This Grok account is already saved')
  }
  index.accounts.push({
    id,
    email: auth.session.email,
    userId: auth.session.userId,
    teamId: auth.session.teamId
  })
  writeFileAtomically(join(getGrokAccountsRoot(), 'accounts.json'), JSON.stringify(index), {
    mode: 0o600
  })
}

export async function addGrokAccount(replaceAccountId?: string): Promise<GrokAccountsState> {
  if (pendingLogin) {
    throw new Error('A Grok sign-in is already in progress')
  }
  const controller = new AbortController()
  pendingLogin = controller
  const id = randomUUID()
  let home: string | null = null
  let captured = false
  let terminated = true
  try {
    if (
      replaceAccountId &&
      !readGrokAccountIndex().accounts.some((a) => a.id === replaceAccountId)
    ) {
      throw new Error('Grok account was not found')
    }
    home = createHome(id)
    terminated = false
    const result = await runProcess({
      program: resolveCliCommand('grok'),
      args: ['login', '--oauth'],
      env: { ...process.env, GROK_HOME: home, ELECTRON_RUN_AS_NODE: undefined },
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 16 * 1024,
      signal: controller.signal,
      terminationBarrier: true,
      onChildTerminated: () => {
        terminated = true
      }
    })
    if (controller.signal.aborted) {
      throw new Error('Grok sign-in cancelled')
    }
    if (result.code !== 0) {
      throw new Error('Grok sign-in did not finish. Please try again.')
    }
    if (replaceAccountId) {
      const account = readGrokAccountIndex().accounts.find((a) => a.id === replaceAccountId)
      const auth = readGrokAuthSession(home)
      if (
        !account ||
        auth.status !== 'ok' ||
        auth.session.userId !== account.userId ||
        auth.session.teamId !== account.teamId
      ) {
        throw new Error('Sign in with the account you chose to reconnect')
      }
      writeFileAtomically(
        join(getOwnedGrokAccountHome(replaceAccountId), 'auth.json'),
        readFileSync(join(home, 'auth.json'), 'utf8'),
        { mode: 0o600 }
      )
    } else {
      captureGrokAccount(home, id)
      captured = true
    }
    return await listGrokAccounts()
  } finally {
    pendingLogin = null
    if (home && !captured && terminated && getOwnedGrokAccountHome(id) === home) {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

export function cancelGrokAccountLogin(): void {
  pendingLogin?.abort()
}

export async function importGrokAccount(sourceHome: string): Promise<GrokAccountsState> {
  const auth = readGrokAuthSession(sourceHome)
  if (auth.status !== 'ok') {
    throw new Error('No Grok sign-in was found in that folder')
  }
  if (
    readGrokAccountIndex().accounts.some(
      (a) => a.userId === auth.session.userId && a.teamId === auth.session.teamId
    )
  ) {
    throw new Error('This Grok account is already saved')
  }
  const id = randomUUID()
  const home = createHome(id)
  try {
    writeFileAtomically(
      join(home, 'auth.json'),
      readFileSync(join(sourceHome, 'auth.json'), 'utf8'),
      { mode: 0o600 }
    )
    captureGrokAccount(home, id)
  } catch (error) {
    if (getOwnedGrokAccountHome(id) === home) {
      rmSync(home, { recursive: true, force: true })
    }
    throw error
  }
  return await listGrokAccounts()
}

export async function selectGrokAccount(
  id: string | null,
  onSelected?: () => void
): Promise<GrokAccountsState> {
  const index = readGrokAccountIndex()
  if (id !== null) {
    const account = index.accounts.find((a) => a.id === id)
    if (!account) {
      throw new Error('Grok account was not found')
    }
    const auth = readGrokAuthSession(getOwnedGrokAccountHome(id))
    if (
      auth.status !== 'ok' ||
      auth.session.userId !== account.userId ||
      auth.session.teamId !== account.teamId
    ) {
      throw new Error('Grok sign-in no longer matches this account')
    }
  }
  index.activeAccountId = id
  mkdirSync(getGrokAccountsRoot(), { recursive: true, mode: 0o700 })
  writeFileAtomically(join(getGrokAccountsRoot(), 'accounts.json'), JSON.stringify(index), {
    mode: 0o600
  })
  onSelected?.()
  return await listGrokAccounts()
}

export async function listGrokAccounts(): Promise<GrokAccountsState> {
  const index = readGrokAccountIndex()
  const usage: GrokAccountsState['usage'] = {}
  await Promise.all(
    index.accounts.map(async (account) => {
      try {
        const home = getOwnedGrokAccountHome(account.id)
        const auth = readGrokAuthSession(home)
        const matches =
          auth.status === 'ok' &&
          auth.session.userId === account.userId &&
          auth.session.teamId === account.teamId
        usage[account.id] = await fetchGrokRateLimits({
          authHome: matches ? home : undefined,
          authReadResult: matches
            ? auth
            : { status: 'error', error: 'Grok sign-in no longer matches this account' }
        })
      } catch {
        usage[account.id] = {
          provider: 'grok',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          status: 'error',
          error: 'Unable to read this saved Grok account. Please sign in again.'
        }
      }
    })
  )
  return { accounts: index.accounts, activeAccountId: index.activeAccountId, usage }
}
