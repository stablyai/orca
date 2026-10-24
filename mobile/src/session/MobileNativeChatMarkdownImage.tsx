import { MobileNativeChatImageGallery } from './MobileNativeChatImageGallery'
import { routeNativeChatHref } from '../../../src/shared/native-chat-href-routing'

export function renderMobileNativeChatMarkdownImage(uri: string, alt: string): React.ReactNode {
  const route = routeNativeChatHref(uri)
  return (
    <MobileNativeChatImageGallery
      images={[
        route.kind === 'file'
          ? { type: 'image-ref', path: route.pathText, alt }
          : { type: 'image-ref', url: uri, alt }
      ]}
      alignToEnd={false}
    />
  )
}
