export function chatSelectionProbeRouteSource(transcriptDir, composerModule) {
  return String.raw`import { useState } from 'react'
import { View } from 'react-native'
import { MobileNativeChatMessage } from ${JSON.stringify(`${transcriptDir}/MobileNativeChatMessage`)}
import { MobileNativeChatRowOverlaysHost } from ${JSON.stringify(`${transcriptDir}/MobileNativeChatRowOverlaysHost`)}
import { MobileNativeChatPageScroll } from ${JSON.stringify(`${transcriptDir}/MobileNativeChatPageScroll`)}
import { MobileNativeChatComposerField } from ${JSON.stringify(composerModule)}

const content = 'Android selection probe.\n\nRead [the guide](https://example.com/guide) and \`src/main.ts\`.\n\n' +
  Array.from({ length: 25 }, (_, index) => 'Scrollable paragraph ' + index + '.').join('\n\n')
const message = { id: 'selection', role: 'assistant', source: 'transcript', timestamp: null,
  blocks: [{ type: 'text', text: content }] }

export default function ChatSelectionProbe() {
  const [text, setText] = useState('')
  const [row, setRow] = useState(message)
  globalThis.__orcaChatSelection = {
    content,
    update: () => setRow({ ...message, blocks: [{ type: 'text', text: content + '\n\nStreaming update.' }] })
  }
  return <View style={{ flex: 1 }}>
    <MobileNativeChatRowOverlaysHost conversation={{ surfaceId: 'selection', sessionId: null }}>
      <MobileNativeChatPageScroll testID="chat-scroll">
        <MobileNativeChatMessage message={row} onOpenFile={(path) => {
          globalThis.__orcaChatOpenedFile = path
        }} />
      </MobileNativeChatPageScroll>
    </MobileNativeChatRowOverlaysHost>
    <MobileNativeChatComposerField value={text} onChangeText={setText}
      placeholder="Message" accessibilityLabel="Message" skillToken={null}
      dictationPreview={null} multiline scrollEnabled />
  </View>
}
`
}
