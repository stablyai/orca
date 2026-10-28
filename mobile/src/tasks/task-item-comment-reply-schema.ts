import { z } from 'zod'
import { prFlag, prText } from '../session/github-pr-entity-reply-schema'
import { taskCommentWriteEnvelopeSchema } from './task-provider-entity-reply-schema'

// Missing or unreadable comments retain the local echo; callers handle optional ok/error fields themselves.
export const taskCommentWrittenSchema = taskCommentWriteEnvelopeSchema

// Linear may omit id; the caller still displays the typed comment under a local id.
export const linearCommentWrittenSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  id: prText('id')
})

// Only true confirms a thread toggle; false and non-boolean replies must not imply a write.
export { githubPrMutationConfirmationSchema as reviewThreadResolvedSchema } from '../session/github-pr-mutation-reply-schema'
