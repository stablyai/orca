import {
  File as FileIcon,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Music
} from 'lucide-react-native'
import { mobileAttachmentFileKind } from './mobile-attachment-file-kind'

export function MobileAttachmentFileIcon({
  name,
  mime,
  size,
  color,
  strokeWidth = 2
}: {
  name: string
  mime?: string
  size: number
  color: string
  strokeWidth?: number
}): React.JSX.Element {
  const props = { size, color, strokeWidth }
  switch (mobileAttachmentFileKind(name, mime)) {
    case 'video':
      return <Film {...props} />
    case 'audio':
      return <Music {...props} />
    case 'archive':
      return <FileArchive {...props} />
    case 'image':
      return <ImageIcon {...props} />
    case 'spreadsheet':
      return <FileSpreadsheet {...props} />
    case 'document':
      return <FileText {...props} />
    case 'code':
      return <FileCode {...props} />
    case 'file':
      return <FileIcon {...props} />
  }
}
