import type { ComponentProps } from 'react'
import { MobileBrowserPane } from './MobileBrowserPane'
import { MobileBrowserClientHostState } from './pane-view/MobileBrowserClientHostState'

/** The streamed page, or which desktop draws it when the host can't stream it to this phone. */
export function MobileBrowserTabBody(props: ComponentProps<typeof MobileBrowserPane>) {
  const { clientHost, url } = props.tab
  return clientHost ? (
    <MobileBrowserClientHostState
      clientHost={clientHost}
      url={url}
      bottomInset={props.bottomInset}
    />
  ) : (
    <MobileBrowserPane {...props} />
  )
}
