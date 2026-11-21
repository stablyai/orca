import type {
  CodexHookPassWorkerRequest,
  CodexHookPassWorkerResult
} from '../../hooks/installation/codex-hook-pass-worker'

export type CodexProjectTrustWorkerRequest =
  | {
      id: number
      kind: 'grant'
      configFiles: readonly string[]
      workspacePath: string
      ledgerPath: string
    }
  | { id: number; kind: 'sessionDeletionEnvironment' }
  | { id: number; kind: 'listOwnedConfigs'; projectPath: string; ledgerPath: string }
  | { id: number; kind: 'removeOwned'; configPath: string; projectPath: string; ledgerPath: string }
  | { id: number; kind: 'removeAntigravityOwned'; workspacePath: string; ledgerPath: string }
  | ({ id: number; kind: 'hookPass' } & CodexHookPassWorkerRequest)

export type CodexSessionDeletionEnvironment = { accountHomes: string[]; command: string }

export type CodexProjectTrustWorkerFailure = { name: string; message: string; code?: string }

export type CodexProjectTrustWorkerResponse =
  | {
      id: number
      ok: true
      configFiles?: string[]
      hookPass?: CodexHookPassWorkerResult
      deletionEnvironment?: CodexSessionDeletionEnvironment
    }
  | { id: number; ok: false; error: CodexProjectTrustWorkerFailure }
