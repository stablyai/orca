import { afterEach, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { AcpAuthRequiredError } from '../transport/acp-errors'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { signedOutAsUnavailable } from './acp-listing-signed-out'
import { forgetAntigravityHostAcpChecks } from '../../antigravity/antigravity-host-acp'

afterEach(() => forgetAntigravityHostAcpChecks())

function listingError(): unknown {
  try {
    signedOutAsUnavailable(ANTIGRAVITY_ACP_DIALECT)(new AcpAuthRequiredError('Authentication required'))
  } catch (error) {
    return error
  }
  return null
}

// One auth-required answer to a model listing, as agy gives while its keychain stalls, must not
// make the model picker say Antigravity isn't signed in.
it("does not report Antigravity's model list as signed out on one auth-required answer", () => {
  const error = listingError()
  expect(error).toBeInstanceOf(Error)
  expect(
    error instanceof AgentModelCatalogUnavailableError && error.unavailable.reason === 'notSignedIn'
  ).toBe(false)
})
