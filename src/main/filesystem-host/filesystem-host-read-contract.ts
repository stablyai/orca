import type {
  FilesystemCliCommandName,
  FilesystemSnapshotFileKind,
  RateLimitCredentialFileKind
} from '../../shared/filesystem-host-protocol'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

export type FilesystemHostReadClient = {
  discoverGeminiOAuth?(): Promise<{ clientId: string; clientSecret: string } | null>
  isSymlink?(path: string): Promise<boolean>
  canonicalizePath(path: string, storageClass?: FilesystemStorageClass): Promise<string>
  readOrcaYaml(path: string): Promise<string>
  readKeybindings(path: string): Promise<string>
  prepareKeybindings?(
    path: string,
    platform: NodeJS.Platform,
    legacyOverrides: KeybindingOverrides | undefined,
    seedLegacyTabSwitchBindings: boolean,
    change?: { ensure?: boolean; mutation?: { actionId: string; bindings: string[] | null } }
  ): Promise<{ contents: string | null; seedCompleted: boolean }>
  readSnapshotFile(path: string, fileKind: FilesystemSnapshotFileKind): Promise<Buffer>
  prepareRateLimitPtyCwd(path: string): Promise<string>
  resolveCliCommand?(commandName: FilesystemCliCommandName): Promise<string>
  writeRateLimitCredential?(
    path: string,
    fileKind: RateLimitCredentialFileKind,
    contents: string
  ): Promise<void>
}
