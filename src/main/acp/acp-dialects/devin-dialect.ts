import { z } from 'zod'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'
import {
  ACP_FORM_ELICITATION_METHOD,
  acpFormElicitationPresentation
} from '../requests/acp-form-elicitation'
import { isAcpUrlElicitation } from '../requests/acp-url-elicitation'
import { AcpRpcError } from '../transport/acp-errors'

const CLOUD_SETUP_META_PREFIX = 'cognition.ai/cloudSetup'
const askUserQuestionSchema = z.looseObject({
  _meta: z.looseObject({ 'cognition.ai/allowOther': z.literal(true) })
})

// Only ask_user_question gets a card: /cloud-setup forms may ask for secrets that the transcript keeps.
function askUserQuestionPresentation(params: unknown): AcpRequestPresentation {
  const parsed = askUserQuestionSchema.safeParse(params)
  if (
    !parsed.success ||
    Object.keys(parsed.data._meta).some((key) => key.startsWith(CLOUD_SETUP_META_PREFIX))
  ) {
    throw new AcpRpcError(-32602, 'Unsupported Devin elicitation form')
  }
  // ask_user_question promises the model an "Other" answer; Devin reads typed text as the value.
  return acpFormElicitationPresentation(params, { writeIns: true })
}

// Its mode commands would switch modes behind the permission picker; sign-in belongs to Orca's setup.
export const DEVIN_ACP_DIALECT: AcpDialect = {
  // Devin's ask_user_question rides standard ACP elicitation; without the form cap it asks in text.
  clientCapabilities: { elicitation: { form: {} } },
  request: (method, params) =>
    method === ACP_FORM_ELICITATION_METHOD && !isAcpUrlElicitation(params)
      ? askUserQuestionPresentation(params)
      : undefined,
  withheldCommands: ['ask', 'plan', 'code', 'smart', 'bypass', 'login', 'logout']
}
