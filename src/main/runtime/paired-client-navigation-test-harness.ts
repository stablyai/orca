import { expect } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'

export const REPO_ID = 'repo-1'
export const FOLDER_REPO_ID = 'folder-repo-1'
export const worktreeId = (name: string): string => `${REPO_ID}::/tmp/${name}`
export const HOST_WORKTREE_ID = worktreeId('host')
export const CLIENT_A_WORKTREE_ID = worktreeId('client-a')
export const CLIENT_A2_WORKTREE_ID = worktreeId('client-a2')
export const CLIENT_B_WORKTREE_ID = worktreeId('client-b')
export const SESSION_WORKTREE_ID = worktreeId('session')

export type PairedSession = {
  ws: WebSocket
  sharedKey: Uint8Array
}

export type ResponseReader = {
  next: (
    id: string,
    predicate?: (response: Record<string, unknown>) => boolean
  ) => Promise<Record<string, unknown>>
  dispose: () => void
}

export function makeStore() {
  const worktreeMeta = Object.fromEntries(
    [
      HOST_WORKTREE_ID,
      CLIENT_A_WORKTREE_ID,
      CLIENT_A2_WORKTREE_ID,
      CLIENT_B_WORKTREE_ID,
      SESSION_WORKTREE_ID
    ].map((id) => [
      id,
      {
        displayName: id.split('/').at(-1) ?? id,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        instanceId: id
      }
    ])
  )
  const repos = [
    {
      id: REPO_ID,
      path: '/tmp/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    },
    // Why: a folder project reaches the same create-activation notifier without a real git worktree add.
    {
      id: FOLDER_REPO_ID,
      path: '/tmp/folder-project',
      displayName: 'folder-project',
      kind: 'folder',
      badgeColor: 'blue',
      addedAt: 2
    }
  ]
  return {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (id: string) => worktreeMeta[id],
    setWorktreeMeta: (id: string, patch: Record<string, unknown>) => {
      const next = { ...worktreeMeta[id], ...patch }
      worktreeMeta[id] = next as (typeof worktreeMeta)[string]
      return next as never
    },
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

function connect(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(typeof data === 'string' ? data : data.toString('utf-8')))
  })
}

export async function authenticate(pairingUrl: string): Promise<PairedSession> {
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('invalid_pairing_url')
  }
  const ws = await connect(pairing.endpoint)
  const keys = generateKeyPair()
  const serverPublicKey = Uint8Array.from(Buffer.from(pairing.publicKeyB64, 'base64'))
  const sharedKey = deriveSharedKey(keys.secretKey, serverPublicKey)
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    })
  )
  expect(JSON.parse(await nextMessage(ws))).toEqual({ type: 'e2ee_ready' })
  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
  )
  expect(JSON.parse(decrypt(await nextMessage(ws), sharedKey)!)).toEqual({
    type: 'e2ee_authenticated'
  })
  return { ws, sharedKey }
}

export function send(session: PairedSession, request: Record<string, unknown>): void {
  session.ws.send(encrypt(JSON.stringify(request), session.sharedKey))
}

export function createReader(session: PairedSession): ResponseReader {
  type Waiter = {
    id: string
    predicate: (response: Record<string, unknown>) => boolean
    resolve: (response: Record<string, unknown>) => void
  }
  const queued: Record<string, unknown>[] = []
  const waiters: Waiter[] = []
  const onMessage = (data: WebSocket.RawData): void => {
    const plaintext = decrypt(
      typeof data === 'string' ? data : data.toString('utf-8'),
      session.sharedKey
    )
    if (!plaintext) {
      return
    }
    const response = JSON.parse(plaintext) as Record<string, unknown>
    const waiterIndex = waiters.findIndex(
      (waiter) => response.id === waiter.id && waiter.predicate(response)
    )
    if (waiterIndex === -1) {
      queued.push(response)
      return
    }
    waiters.splice(waiterIndex, 1)[0]?.resolve(response)
  }
  session.ws.on('message', onMessage)
  return {
    next: (id, predicate = () => true) => {
      const queuedIndex = queued.findIndex((response) => response.id === id && predicate(response))
      if (queuedIndex !== -1) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]!)
      }
      return new Promise((resolve) => waiters.push({ id, predicate, resolve }))
    },
    dispose: () => {
      session.ws.off('message', onMessage)
      queued.length = 0
      waiters.length = 0
    }
  }
}

export function resultType(response: Record<string, unknown>): string | undefined {
  return (response.result as { type?: string } | undefined)?.type
}

export function activeTabId(response: Record<string, unknown>): string | null {
  return (response.result as RuntimeMobileSessionTabsResult | undefined)?.activeTabId ?? null
}

export function snapshotVersion(response: Record<string, unknown>): number {
  return (response.result as RuntimeMobileSessionTabsResult | undefined)?.snapshotVersion ?? -1
}

export function seedSessionTabs(runtime: OrcaRuntimeService): void {
  const tabs = ['host-tab', 'client-a-tab', 'client-a2-tab', 'client-b-tab'].map((id, index) => ({
    type: 'terminal' as const,
    id,
    parentTabId: id,
    leafId: `pane:${index + 1}`,
    ptyId: `pty-${index + 1}`,
    title: id,
    isActive: id === 'host-tab'
  }))
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: SESSION_WORKTREE_ID,
        publicationEpoch: 'renderer:host',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab',
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'group-1',
            activeTabId: 'host-tab',
            tabOrder: tabs.map((tab) => tab.parentTabId)
          }
        ],
        tabs
      }
    ]
  })
  for (let index = 0; index < tabs.length; index += 1) {
    runtime.registerPty(`pty-${index + 1}`, SESSION_WORKTREE_ID)
  }
}
