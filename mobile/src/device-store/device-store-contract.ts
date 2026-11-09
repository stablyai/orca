import type { GenerationFileSystem } from '../mobile-web-shell/generation-store-file-system'
import type { DeviceStoreRoots } from './device-store-files'
import type { DeviceStoreKeychain } from './device-store-key'
import type { DeviceStoreTable } from './device-store-seal'

export type DeviceStoreWriteOp = { readonly key: string; readonly value: string | null }

export type DeviceStoreRefusal = 'too-large' | 'over-cap' | 'unavailable'

export type DeviceStoreWriteResult =
  | { readonly written: true }
  | { readonly written: false; readonly refusal: DeviceStoreRefusal }

export type DeviceStoreReadResult =
  | { readonly status: 'ok'; readonly values: readonly (string | null)[] }
  | { readonly status: 'unavailable' }

export type DeviceStore = {
  // Values come back in key order; null is a miss.
  read(
    hostId: string,
    table: DeviceStoreTable,
    keys: readonly string[]
  ): Promise<DeviceStoreReadResult>
  // Resolves once every op is on disk, applied in order; a null value deletes.
  write(
    hostId: string,
    table: DeviceStoreTable,
    ops: readonly DeviceStoreWriteOp[]
  ): Promise<DeviceStoreWriteResult>
  // Every table by default; a revoked host loses only its cached screens and keeps drafts until removal.
  wipeHost(hostId: string, tables?: readonly DeviceStoreTable[]): Promise<void>
  // While a host is revoked its cache refuses writes, so a page's pending flush can't bring a wipe back.
  fenceHostCache(hostId: string, fenced: boolean): void
  // Loads the key unless it is already loaded; an unavailable store retries here.
  open(): Promise<'ready' | 'unavailable'>
  // The launch pass over both roots. Later runs redo only a pass that missed files.
  runLaunchMaintenance(): Promise<void>
}

export type DeviceStoreOptions = {
  readonly fileSystem: GenerationFileSystem
  readonly roots: DeviceStoreRoots
  readonly keychain: DeviceStoreKeychain
  // Null when the host list can't be read.
  loadPairedHostIds(): Promise<readonly string[] | null>
}
