import { LEGACY_REMOTE_METHODS } from '../../../../orchestration/legacy-remote/legacy-remote'
import { ORCHESTRATION_PEER_MAIL_METHODS } from './peer-mail-methods'

export const ORCHESTRATION_FEDERATION_METHODS = [
  ...LEGACY_REMOTE_METHODS,
  ...ORCHESTRATION_PEER_MAIL_METHODS
]
