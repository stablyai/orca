import {
  LINEAR_PROJECT_LABELS_NOUN,
  LINEAR_PROJECT_STATUSES_NOUN,
  formatLinearProjectCreate,
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  formatLinearProjectUpdateAdd,
  linearProjectFanoutWarningLines
} from '../../shared/linear/project-agent-format'
import {
  isLinearProjectCreateResult,
  isLinearProjectLabelsResult,
  isLinearProjectShowResult,
  isLinearProjectStatusesResult,
  isLinearProjectUpdateAddResult
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
  if (isLinearProjectUpdateAddResult(result)) {
    return { stdout: `${formatLinearProjectUpdateAdd(result)}\n`, stderr: '' }
  }
  if (isLinearProjectCreateResult(result)) {
    return { stdout: `${formatLinearProjectCreate(result)}\n`, stderr: '' }
  }
  return null
}

function warningBlock(warnings: string[]): string {
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}
