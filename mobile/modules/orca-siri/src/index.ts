import { requireOptionalNativeModule } from 'expo-modules-core'

export type OrcaSiriConfiguration = { configured: false } | { configured: true; url: string }

export type OrcaSiriConnectionTest =
  | { ok: true; ms: number; prompts: number; agents: number; speech: string }
  | { ok: false; ms: number; error: string }

export type OrcaSiriModule = {
  getConfiguration(): Promise<OrcaSiriConfiguration>
  configure(url: string, token: string): Promise<void>
  clearConfiguration(): Promise<void>
  testConnection(): Promise<OrcaSiriConnectionTest>
}

/** Null on Android and in binaries built before the module existed. */
export const OrcaSiri = requireOptionalNativeModule<OrcaSiriModule>('OrcaSiri')
