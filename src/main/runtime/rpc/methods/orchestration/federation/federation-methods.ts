import { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from '../../../../orchestration/legacy-remote/federation'
import { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from '../../../../orchestration/legacy-remote/federation-control'
import { ORCHESTRATION_FEDERATION_RELAY_METHODS } from '../../../../orchestration/legacy-remote/federation-relay'
import { ORCHESTRATION_PEER_MAIL_METHODS } from './peer-mail-methods'
import { ORCHESTRATION_PEER_RUN_METHODS } from './peer-run-methods'

export const ORCHESTRATION_FEDERATION_METHODS = [
  ...ORCHESTRATION_FEDERATION_ATTACH_METHODS,
  ...ORCHESTRATION_FEDERATION_RELAY_METHODS,
  ...ORCHESTRATION_FEDERATION_CONTROL_METHODS,
  ...ORCHESTRATION_PEER_MAIL_METHODS,
  ...ORCHESTRATION_PEER_RUN_METHODS
]
