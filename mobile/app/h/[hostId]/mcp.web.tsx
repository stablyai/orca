import { MobileMcpServersScreen } from '../../../src/mcp-servers/MobileMcpServersScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileMcpServersRoute() {
  return <MobileMcpServersScreen />
}
