import React from 'react'
import { AppRegistry, View } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { OrcaMobileWebShellView } from '../../modules/orca-mobile-web-shell/src'

import { runJourney, record } from './page-lifetime-journey'

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
    await runJourney(() => this.shellMessages)
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
