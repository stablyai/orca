import type { FilesystemSnapshotFileKind } from '../../shared/filesystem-host-protocol'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type {
  FilesystemHostReadAuthority,
  FilesystemHostReadClient
} from './filesystem-host-read-authority'
import { FilesystemHostReadError } from './filesystem-host-read-result'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

const READ_AUTHORITY_STATE_KEY = '__orcaFilesystemHostReadAuthorityState'

type FilesystemHostReadAuthorityState = {
  client: FilesystemHostReadClient | null
  authority: FilesystemHostReadAuthority | null
}

function getReadAuthorityState(): FilesystemHostReadAuthorityState {
  const scope = globalThis as unknown as Record<string, unknown>
  let state = scope[READ_AUTHORITY_STATE_KEY] as FilesystemHostReadAuthorityState | undefined
  if (!state) {
    state = { client: null, authority: null }
    scope[READ_AUTHORITY_STATE_KEY] = state
  }
  return state
}

export function configureFilesystemHostReadAuthority(authority: FilesystemHostReadAuthority): void {
  const state = getReadAuthorityState()
  state.client = authority
  state.authority = authority
}

export function setFilesystemHostReadClientForTests(client: FilesystemHostReadClient | null): void {
  const state = getReadAuthorityState()
  state.client = client
  state.authority = null
}

export function hydrateFilesystemHostFailureDomains(paths: readonly string[]): void {
  getReadAuthorityState().authority?.hydrateFailureDomains(paths)
}

export function reconcileFilesystemHostFailureDomains(paths: readonly string[]): void {
  getReadAuthorityState().authority?.reconcileFailureDomains(paths)
}

export function requireFilesystemHostReadClient(): FilesystemHostReadClient {
  const client = getReadAuthorityState().client
  if (!client) {
    throw new FilesystemHostReadError('unavailable')
  }
  return client
}

export async function canonicalizePathThroughFilesystemHost(
  path: string,
  storageClass?: FilesystemStorageClass
): Promise<string> {
  return await requireFilesystemHostReadClient().canonicalizePath(path, storageClass)
}

export async function readOrcaYamlThroughFilesystemHost(path: string): Promise<string> {
  return await requireFilesystemHostReadClient().readOrcaYaml(path)
}

export async function readKeybindingsThroughFilesystemHost(path: string): Promise<string> {
  return await requireFilesystemHostReadClient().readKeybindings(path)
}

export async function prepareKeybindingsThroughFilesystemHost(
  path: string,
  platform: NodeJS.Platform,
  legacyOverrides: KeybindingOverrides | undefined,
  seedLegacyTabSwitchBindings: boolean
): Promise<{ contents: string | null; seedCompleted: boolean }> {
  const client = requireFilesystemHostReadClient()
  if (client.prepareKeybindings) {
    return await client.prepareKeybindings(
      path,
      platform,
      legacyOverrides,
      seedLegacyTabSwitchBindings
    )
  }
  try {
    return { contents: await client.readKeybindings(path), seedCompleted: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { contents: null, seedCompleted: false }
    }
    throw error
  }
}

export async function readSnapshotFileThroughFilesystemHost(
  path: string,
  fileKind: FilesystemSnapshotFileKind
): Promise<Buffer> {
  return await requireFilesystemHostReadClient().readSnapshotFile(path, fileKind)
}

export async function prepareRateLimitPtyCwdThroughFilesystemHost(path: string): Promise<string> {
  return await requireFilesystemHostReadClient().prepareRateLimitPtyCwd(path)
}
