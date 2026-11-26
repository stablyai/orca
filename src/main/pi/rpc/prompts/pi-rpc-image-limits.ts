import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
} from '../../../../shared/agent-session/agent-session-attachments'
import { resolveJsonlRpcPeerOptions } from '../../../jsonl-rpc/peer-limits'

// Pi before 1.5.1 sends mid-turn images unshrunk.
export const PI_UNSHRUNK_IMAGE_LIMITS = {
  image: (5 * 1024 * 1024 * 3) / 4,
  total: (resolveJsonlRpcPeerOptions().maxLineBytes * 3) / 4
}
const PI_SHRUNK_IMAGE_LIMITS = {
  image: AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  total: AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
}

export function piRpcImageLimits(shrinksImages: boolean) {
  return shrinksImages ? PI_SHRUNK_IMAGE_LIMITS : PI_UNSHRUNK_IMAGE_LIMITS
}
