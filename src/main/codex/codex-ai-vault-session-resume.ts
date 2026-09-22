import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'

type CodexAiVaultRuntimeHome = Pick<
  CodexRuntimeHomeService,
  'isHostSystemDefaultRealHome' | 'resolveSelectedHostAccountCodexHomePathForResume'
>

/** Keeps window and serve AI Vault resumes behind the same refusing account-home gate. */
export function prepareCodexAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    runtimeHome: CodexAiVaultRuntimeHome | null
    systemCodexHomePath: string | undefined
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  return prepareLegacySharedCodexSessionResume(args, {
    isHostSystemDefaultRealHome: () => options.runtimeHome?.isHostSystemDefaultRealHome() === true,
    getSelectedHostAccountCodexHomePath: () =>
      options.runtimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null,
    systemCodexHomePath: options.systemCodexHomePath
  })
}
