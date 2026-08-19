import {
  LINEAR_PROJECT_LABELS_NOUN,
  LINEAR_PROJECT_STATUSES_NOUN,
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  linearProjectFanoutWarningLines
} from '../../shared/linear/project-agent-format'
import {
  isLinearProjectLabelsResult,
  isLinearProjectShowResult,
  isLinearProjectStatusesResult
} from './ssh-remote-linear-result-guards'

/** Renders through the shared formatter so SSH output matches the local CLI byte for byte. */
export function formatRemoteLinearProjectCli(
  result: unknown
): { stdout: string; stderr: string } | null {
  if (isLinearProjectShowResult(result)) {
    return { stdout: `${formatLinearProjectShow(result)}\n`, stderr: '' }
  }
  if (isLinearProjectStatusesResult(result)) {
    return {
      stdout: `${formatLinearProjectStatuses(result)}\n`,
      stderr: warningBlock(
        linearProjectFanoutWarningLines(result.meta, LINEAR_PROJECT_STATUSES_NOUN)
      )
    }
  }
  if (isLinearProjectLabelsResult(result)) {
    return {
      stdout: `${formatLinearProjectLabels(result)}\n`,
      stderr: warningBlock(linearProjectFanoutWarningLines(result.meta, LINEAR_PROJECT_LABELS_NOUN))
    }
  }
  return null
}

function warningBlock(warnings: string[]): string {
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}
