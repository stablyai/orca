import { requireNativeModule } from 'expo-modules-core'
import { AppRegistry } from 'react-native'

/** Fixture only: the caller supplies an already listening, owned loopback proxy. */
export type NativeBrowserFixtureRoute = {
  authorityId: string
  executionHostId: string
  orcaProfileId: string
  browserProfileId: string
  proxyUrl: string
}

export type NativeBrowserPage = { generation: string; pid: number; profile: string }
export type NativeBrowserCommand =
  | { operation: 'navigate'; params: { url: string } }
  | { operation: 'evaluate'; params: { expression: string } }
  | { operation: 'click'; params: { x: number; y: number } }
  | { operation: 'insertText'; params: { text: string } }
  | { operation: 'accessibility' | 'screenshot' }

type NativeBrowserModule = {
  openBrowserFixture(route: string): Promise<string>
  browserCommand(generation: string, command: string): Promise<string>
  resumeBrowser(generation: string): Promise<string>
  closeBrowser(generation: string): Promise<string>
  waitBrowserTaskStopped(generation: string, taskToken: string): Promise<string>
}

function nativeModule(): NativeBrowserModule {
  return requireNativeModule<NativeBrowserModule>('OrcaMobileWebShell')
}

export async function openNativeBrowserFixture(
  route: NativeBrowserFixtureRoute
): Promise<NativeBrowserPage> {
  const result: unknown = JSON.parse(await nativeModule().openBrowserFixture(JSON.stringify(route)))
  if (
    typeof result !== 'object' ||
    result === null ||
    !('generation' in result) ||
    typeof result.generation !== 'string' ||
    !('pid' in result) ||
    typeof result.pid !== 'number' ||
    !('profile' in result) ||
    typeof result.profile !== 'string'
  ) {
    throw new Error('Invalid native browser page')
  }
  return { generation: result.generation, pid: result.pid, profile: result.profile }
}

export async function nativeBrowserCommand(
  page: NativeBrowserPage,
  command: NativeBrowserCommand
): Promise<unknown> {
  return JSON.parse(await nativeModule().browserCommand(page.generation, JSON.stringify(command)))
}

export async function closeNativeBrowser(page: NativeBrowserPage): Promise<void> {
  await nativeModule().closeBrowser(page.generation)
}

// The guest pauses the shell Activity; keep its existing JS runtime available for commands.
AppRegistry.registerHeadlessTask(
  'OrcaBrowserGuest',
  () => async (data: { generation: string; taskToken: string }) => {
    await nativeModule().waitBrowserTaskStopped(data.generation, data.taskToken)
  }
)

export async function resumeNativeBrowser(page: NativeBrowserPage): Promise<void> {
  await nativeModule().resumeBrowser(page.generation)
}
