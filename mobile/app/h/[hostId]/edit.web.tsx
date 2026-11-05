import CatchAllPageRoute from '../../../src/mobile-web-shell/catch-all-page-route'

// Native-only: the page hands this path to native, keeping the edit form out of page chunks.
// Own component, not a re-export: an identical re-export compiles to the same asset as [...page] and duplicates it in the manifest.
export default function EditHostPageRoute() {
  return <CatchAllPageRoute />
}
