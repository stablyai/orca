import { existsSync } from 'node:fs'

export async function applyMaestroWorkspaceE2EQueryControl(): Promise<void> {
  if (process.env.NODE_ENV !== 'development') {
    return
  }
  const rawDelay = Number(process.env.ORCA_E2E_MWC_QUERY_DELAY_MS) || 0
  const delay = Math.min(1_500, Math.max(0, rawDelay))
  if (delay) {
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  const faultFile = process.env.ORCA_E2E_MWC_AUTHORITY_FAULT_FILE
  if (faultFile && existsSync(faultFile)) {
    throw new Error('e2e_workspace_authority_unreachable')
  }
}
