import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES } from '../../shared/agent-session/agent-session-attachments'
import { PI_UNSHRUNK_IMAGE_LIMITS } from '../pi/rpc/prompts/pi-rpc-image-limits'
import type { ConnectorImage, EarlierImageBudget } from './connector-asker-images'

export function budgetForEarlierImages(
  agent: ExternalConversationLink['agent'],
  budget: EarlierImageBudget,
  direct: readonly ConnectorImage[]
): EarlierImageBudget {
  if (agent !== 'pi') {
    return budget
  }
  // Before launch we do not know whether this Pi shrinks images. Keep automatic attachments safe
  // on older versions and leave larger files available through the existing download instructions.
  const { image, total } = PI_UNSHRUNK_IMAGE_LIMITS
  return {
    ...budget,
    maxImageBytes: image,
    bytes: Math.min(
      budget.bytes - (AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES - total),
      total - direct.reduce((bytes, image) => bytes + image.bytes, 0)
    )
  }
}

export function earlierImagesThatFit(
  images: readonly ConnectorImage[],
  budget: EarlierImageBudget
) {
  let { count, bytes } = budget
  return images.filter((image) => {
    if (
      count <= 0 ||
      image.bytes > bytes ||
      (budget.maxImageBytes !== undefined && image.bytes > budget.maxImageBytes) ||
      budget.fileIds.has(image.fileId)
    ) {
      return false
    }
    count -= 1
    bytes -= image.bytes
    return true
  })
}
