import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import pngjs from 'pngjs'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const describeRender = mobileWebAppDependenciesPresent() ? describe : describe.skip
const pageRoutes = [
  { pathname: '/h/[hostId]', grants: [] },
  { pathname: '/h/[hostId]/session/[worktreeId]', grants: [] }
]
let scratch
let server
let browser
let origin
let init

function screenSource(name, target) {
  const source = join(projectDir, 'mobile/src')
  return `import { View, Text, Pressable } from 'react-native'
import { MobileAgentIcon } from ${JSON.stringify(join(source, 'components/MobileAgentIcon'))}
import { useRouteHandoff } from ${JSON.stringify(join(source, 'navigation/route-handoff'))}
export default function Screen() {
  const router = useRouteHandoff()
  return <View testID="${name}" style={{ flex: 1, padding: 24, gap: 24 }}>
    <View testID="${name}-omp"><MobileAgentIcon agentId="omp" size={32} /></View>
    <View testID="${name}-gemini"><MobileAgentIcon agentId="gemini" size={32} /></View>
    <Pressable accessibilityRole="button" onPress={() => router.${target ? 'push' : 'back'}(${target ? JSON.stringify(target) : ''})}>
      <Text>${target ? 'Open session' : 'Back'}</Text>
    </Pressable>
  </View>
}`
}

beforeAll(async () => {
  if (!mobileWebAppDependenciesPresent()) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-agent-icon-render-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, 'h')
  await mkdir(join(routeDir, '[hostId]/session'), { recursive: true })
  await writeFile(
    join(routeDir, '_layout.tsx'),
    `import { HostStack } from ${JSON.stringify(join(projectDir, 'mobile/src/navigation/host-stack'))}
export default function Layout() { return <HostStack animation="default" /> }`
  )
  await writeFile(
    join(routeDir, '[hostId]/index.tsx'),
    screenSource('list', '/h/icon-host/session/icon-workspace')
  )
  await writeFile(join(routeDir, '[hostId]/session/[worktreeId].tsx'), screenSource('session'))
  const { outDir } = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes
  })
  const served = await createBundleServer({
    outDir,
    cspHeader: await readShellCsp()
  })
  server = served.server
  origin = served.origin
  init = {
    version: await readBridgeProtocolVersion(),
    sessionId: 'agent-icons',
    buildId: 'agent-icons',
    route: { pathname: '/h/icon-host', params: {} },
    host: { id: 'icon-host', name: 'Icon Host', endpoint: 'ws://icons', lastConnected: 1 },
    storage: {},
    faultGrant: await readBridgeFaultGrant(),
    pageRoutes: pageRoutes.map((route) => route.pathname),
    replies: {}
  }
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openList() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, init)
  await page.goto(origin)
  await page.getByTestId('list').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0)
  return page
}

async function coloredPixels(locator) {
  const image = pngjs.PNG.sync.read(await locator.screenshot())
  let count = 0
  for (let i = 0; i < image.data.length; i += 4) {
    const channels = image.data.subarray(i, i + 3)
    if (Math.max(...channels) - Math.min(...channels) > 30) {
      count += 1
    }
  }
  return count
}

describeRender('mobile agent icons on retained routes', () => {
  it('paints the active OMP mark after the real stack hides its retained parent', async () => {
    const page = await openList()
    try {
      expect(await coloredPixels(page.getByTestId('list-omp'))).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Open session' }).click()
      await page.getByTestId('session').waitFor({ state: 'visible' })
      await page.getByTestId('list').waitFor({ state: 'hidden' })
      expect(await page.getByTestId('list').count()).toBe(1)
      expect(await page.getByTestId('list').isVisible()).toBe(false)
      expect(await coloredPixels(page.getByTestId('session-omp'))).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })
})
