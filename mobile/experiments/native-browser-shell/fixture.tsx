import React from 'react'
import { AppRegistry, Linking, View } from 'react-native'
import { requireNativeModule } from 'expo-modules-core'
import * as FileSystem from 'expo-file-system/legacy'
import { OrcaMobileWebShellView } from '../../modules/orca-mobile-web-shell/src'
import {
  openNativeBrowserFixture,
  nativeBrowserCommand,
  closeNativeBrowser,
  resumeNativeBrowser
} from '../../modules/orca-mobile-web-shell/src/native-browser'

const endpoint = 'http://10.0.2.2:18769'
const route = {
  authorityId: 'fixture-authority',
  executionHostId: 'ssh:fixture',
  orcaProfileId: 'orca-fixture',
  browserProfileId: 'browser-fixture',
  proxyUrl: 'http://127.0.0.1:18769'
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function record(name: string, value: unknown) {
  const response = await fetch(`${endpoint}/evidence/${name}`, {
    method: 'POST',
    body: JSON.stringify(value)
  })
  if (!response.ok) {
    throw new Error(`Evidence refused: ${name}`)
  }
}
async function rejects(action: () => Promise<unknown>, reason: string) {
  try {
    await action()
  } catch (error) {
    if (!String(error).includes(reason)) {
      throw error
    }
    return String(error)
  }
  throw new Error(`Expected rejection: ${reason}`)
}

class Fixture extends React.Component<unknown, { directory: string }> {
  state = { directory: '' }
  started = false
  shellMessages = 0
  async componentDidMount() {
    try {
      const directory = `${FileSystem.documentDirectory}browser-fixture/`
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
      await FileSystem.writeAsStringAsync(
        `${directory}index.html`,
        '<!doctype html><title>OTA shell fixture</title><p>Independent shell</p><script src="boot.js"></script>'
      )
      await FileSystem.writeAsStringAsync(
        `${directory}boot.js`,
        'setInterval(()=>orcaBridge.postMessage("shell-alive"),100)'
      )
      await FileSystem.writeAsStringAsync(
        `${directory}manifest.json`,
        JSON.stringify({
          schemaVersion: 1,
          entrypoint: 'index.html',
          assets: [
            { path: 'index.html', contentType: 'text/html' },
            { path: 'boot.js', contentType: 'application/javascript' }
          ]
        })
      )
      // oxlint-disable-next-line react/no-did-mount-set-state -- The fixture must finish writing its generation before mounting the shell.
      this.setState({ directory: directory.replace('file://', '') })
    } catch (error) {
      await record('failure', String(error))
    }
  }
  async journey() {
    if (this.started) {
      return
    }
    this.started = true
    try {
      const page = await openNativeBrowserFixture(route)
      await record('opened', page)
      await rejects(() => openNativeBrowserFixture(route), 'guest_process_occupied')
      await nativeBrowserCommand(page, {
        operation: 'navigate',
        params: { url: 'http://fixture.invalid/page' }
      })
      let ready = false
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await nativeBrowserCommand(page, {
          operation: 'evaluate',
          params: { expression: 'document.title' }
        })
        if (JSON.stringify(result).includes('Guest fixture')) {
          ready = true
          break
        }
        await delay(100)
      }
      if (!ready) {
        throw new Error('Guest did not navigate through proxy')
      }
      const ax = await nativeBrowserCommand(page, { operation: 'accessibility' })
      await record('ax', ax)
      await nativeBrowserCommand(page, { operation: 'click', params: { x: 90, y: 80 } })
      await nativeBrowserCommand(page, {
        operation: 'insertText',
        params: { text: 'Orca native 한글' }
      })
      const value = await nativeBrowserCommand(page, {
        operation: 'evaluate',
        params: {
          expression:
            'JSON.stringify({value:document.querySelector("input").value,trusted:window.trusted})'
        }
      })
      if (
        !JSON.stringify(value).includes('Orca native 한글') ||
        !JSON.stringify(value).includes('true')
      ) {
        throw new Error(`Trusted input failed: ${JSON.stringify(value)}`)
      }
      await record('input', value)
      await Linking.openURL('orca://fixture')
      await delay(300)
      await rejects(
        () => nativeBrowserCommand(page, { operation: 'accessibility' }),
        'guest_not_foreground'
      )
      await resumeNativeBrowser(page)
      const retained = await nativeBrowserCommand(page, {
        operation: 'evaluate',
        params: { expression: 'document.querySelector("input").value' }
      })
      if (!JSON.stringify(retained).includes('Orca native 한글')) {
        throw new Error('Stopped guest lost document state')
      }
      await record('retained', retained)
      await record('screenshot', await nativeBrowserCommand(page, { operation: 'screenshot' }))
      await record(
        'evalException',
        await rejects(
          () =>
            nativeBrowserCommand(page, {
              operation: 'evaluate',
              params: { expression: 'throw new Error("fixture")' }
            }),
          'evaluation_exception'
        )
      )
      await closeNativeBrowser(page)
      await record('closed', true)
      const second = await openNativeBrowserFixture(route)
      if (
        second.generation === page.generation ||
        second.profile !== page.profile ||
        second.pid === page.pid
      ) {
        throw new Error('Profile/process lifecycle failed')
      }
      await record('reopened', second)
      await record(
        'stale',
        await rejects(
          () => nativeBrowserCommand(page, { operation: 'accessibility' }),
          'stale_guest_generation'
        )
      )
      const pending = rejects(
        () =>
          nativeBrowserCommand(second, {
            operation: 'evaluate',
            params: { expression: 'while(true){}' }
          }),
        'guest_process_exited'
      )
      await delay(200)
      await requireNativeModule<{ terminateBrowserFixture(generation: string): Promise<string> }>(
        'OrcaMobileWebShell'
      ).terminateBrowserFixture(second.generation)
      await record('death', await pending)
      const third = await openNativeBrowserFixture({ ...route, executionHostId: 'wsl:fixture' })
      if (third.profile === second.profile) {
        throw new Error('Execution hosts share storage')
      }
      await closeNativeBrowser(third)
      const before = this.shellMessages
      await delay(400)
      if (this.shellMessages <= before) {
        throw new Error('OTA shell stopped responding')
      }
      await record('passed', { shellMessages: this.shellMessages, third })
    } catch (error) {
      await record('failure', String(error))
    }
  }
  render() {
    return (
      <View style={{ flex: 1 }}>
        {this.state.directory ? (
          <OrcaMobileWebShellView
            style={{ flex: 1 }}
            generationDirectory={this.state.directory}
            sessionId="native_fixture"
            bridgeEnabled
            onBridgeMessage={() => {
              this.shellMessages++
              void this.journey()
            }}
          />
        ) : null}
      </View>
    )
  }
}
AppRegistry.registerComponent('main', () => Fixture)
