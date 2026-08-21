import {
  LINEAR_PROJECT_DESCRIPTION_CAP,
  LINEAR_PROJECT_NAME_CAP,
  linearProjectTextCapError
} from '../../../shared/linear/project-agent-writes'
import { linearError } from '../../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../../linear/linear-text-digest'

/**
 * Rejects over-cap prose before the mutation is sent. Linear enforces both caps
 * server-side, but only as a generic `Argument Validation Error`, and on edit it
 * would arrive after the pre-edit snapshot read has already paged every
 * member, team and label connection. Counts the LF-normalized text, which is
 * what the mutation actually sends.
 */
export function assertLinearProjectTextCaps(
  name: string | undefined,
  description: string | undefined
): void {
  const failure =
    (name !== undefined
      ? linearProjectTextCapError(name, LINEAR_PROJECT_NAME_CAP, 'name')
      : null) ??
    (description !== undefined
      ? linearProjectTextCapError(
          normalizeLinearLineEndings(description),
          LINEAR_PROJECT_DESCRIPTION_CAP,
          'description'
        )
      : null)
  if (failure) {
    throw linearError('linear_invalid_project', failure)
  }
}
