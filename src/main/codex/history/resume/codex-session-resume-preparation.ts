import {
  resolveCodexSessionResumeProvenance,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'

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
  return {
    outcome: 'resume',
    codexHomePath: await args.resolveVerifiedResumeHome({
      homePath: provenance.homePath,
      transcriptPath: provenance.transcriptPath
    })
  }
}
