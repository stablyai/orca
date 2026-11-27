import {
  Bot,
  Brain,
  Eye,
  Folder,
  Globe,
  ListChecks,
  MessageSquareMore,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from '../../../../components/icons/icon-set'
import type { MobileIcon } from '../../../../components/icons/mobile-icon'
import type { NativeChatToolIconName } from '../../../../../../src/shared/native-chat/tools/native-chat-tool-icon'

const GLYPHS: Record<NativeChatToolIconName, MobileIcon> = {
  eye: Eye,
  search: Search,
  folder: Folder,
  'square-terminal': SquareTerminal,
  pencil: Pencil,
  globe: Globe,
  plug: Plug,
  bot: Bot,
  'list-checks': ListChecks,
  wrench: Wrench,
  'message-square-more': MessageSquareMore,
  brain: Brain
}

export function MobileNativeChatToolGlyph({
  name,
  size,
  color
}: {
  name: NativeChatToolIconName
  size: number
  color: string
}): React.JSX.Element {
  const Glyph = GLYPHS[name]
  return <Glyph size={size} color={color} />
}
