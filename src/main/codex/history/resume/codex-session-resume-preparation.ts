import {
  resolveCodexSessionResumeProvenance,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'
import { readCodexSessionResumeProvider } from './codex-session-resume-provider'

export type VerifiedCodexResumeSource = { homePath: string; transcriptPath: string }

/** Only verified provenance may trigger migration, project trust or hook repair. */
export async function prepareCodexSessionResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<CodexSessionResumePreparation> {
  const provenance = await resolveCodexSessionResumeProvenance({
    sessionId: args.sessionId,
    transcriptPath: args.transcriptPath,
    trustedCodexHomes: args.trustedCodexHomes,
    getSelectedAccountCodexHome: args.getSelectedAccountCodexHome,
    systemCodexHomePath: args.systemCodexHomePath,
    sharedRuntimeCodexHomePath: args.sharedRuntimeCodexHomePath,
    ...(args.fileIsRegular ? { fileIsRegular: args.fileIsRegular } : {}),
    ...(args.listSessionFiles ? { listSessionFiles: args.listSessionFiles } : {})
  })
  if (provenance.outcome === 'fresh') {
    return provenance
  }
  let modelProvider = await readCodexSessionResumeProvider({
    sessionId: args.sessionId,
    homePath: provenance.homePath,
    transcriptPath: provenance.transcriptPath
  })
  const codexHomePath = await args.resolveVerifiedResumeHome({
    homePath: provenance.homePath,
    transcriptPath: provenance.transcriptPath
  })
  if (codexHomePath !== provenance.homePath) {
    const targetProvider = await readCodexSessionResumeProvider({
      sessionId: args.sessionId,
      homePath: codexHomePath,
      transcriptPath: provenance.transcriptPath
    })
    if (targetProvider && modelProvider && targetProvider !== modelProvider) {
      throw new Error(
        'Codex resume stopped: the selected account has a different saved model provider'
      )
    }
    modelProvider = targetProvider ?? modelProvider
  }
  return {
    outcome: 'resume',
    ...(modelProvider ? { modelProvider } : {}),
    codexHomePath
  }
}
