export type CodexProjectTrustWorkerRequest =
  | {
      id: number
      kind: 'grant'
      configFiles: readonly string[]
      workspacePath: string
      ledgerPath: string
    }
  | { id: number; kind: 'listOwnedConfigs'; projectPath: string; ledgerPath: string }
  | { id: number; kind: 'removeOwned'; configPath: string; projectPath: string; ledgerPath: string }

export type CodexProjectTrustWorkerFailure = { name: string; message: string; code?: string }

export type CodexProjectTrustWorkerResponse =
  | { id: number; ok: true; configFiles?: string[] }
  | { id: number; ok: false; error: CodexProjectTrustWorkerFailure }
