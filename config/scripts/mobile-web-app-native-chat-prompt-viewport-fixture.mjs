export const PROMPT_QUESTION =
  'How should the workspace retain its split layout when a document is closed and later opened again? Choose the behavior that fits the task.'

export function nativeChatPromptViewportFixture({
  chatViewModule,
  clientContextModule,
  sessionSurfaceModule
}) {
  return `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SafeAreaInsetsContext, SafeAreaProvider } from 'react-native-safe-area-context'
import { View } from 'react-native'
import { MobileNativeChatView } from ${JSON.stringify(chatViewModule)}
${sessionSurfaceModule ? `import { MobileSessionSurface } from ${JSON.stringify(sessionSurfaceModule)}` : ''}
import { RpcClientProvider } from ${JSON.stringify(clientContextModule)}

const params = new URLSearchParams(location.search)
const short = params.has('short')
const insets = { top: Number(params.get('top') ?? 0), bottom: Number(params.get('bottom') ?? 0), left: Number(params.get('left') ?? 0), right: Number(params.get('right') ?? 0) }
const question = {
  header: 'Workspace',
  question: short ? 'Continue?' : ${JSON.stringify(PROMPT_QUESTION)},
  multiSelect: true,
  options: short ? [{ label: 'Continue' }] : [
    {
      label: 'Persist across reload',
      description: 'Keep the layout with the document and restore it after the workspace is opened again. '.repeat(4)
    },
    {
      label: 'Session only',
      description: 'Keep the layout for the current session and start with a single pane after restarting. '.repeat(4)
    }
  ]
}
const prompt = { questions: params.has('steps') ? [question, { ...question, header: 'Details' }] : [question] }
const context = Array.from({ length: 10 }, (_, index) => ({
  id: 'context-' + index,
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Chat context ' + index + ': Review the workspace behavior before choosing how the agent should continue.' }],
  timestamp: index,
  source: 'hook'
}))
// Only the outer transport boundary is a fixture; all chat components are the shipped ones.
const client = {
  getShellSession: () => ({ grants: { native: [] } }),
  getState: () => 'connected',
  onStateChange: () => () => {}
}

function SessionFrame({ collapsed, children }) {
  ${
    sessionSurfaceModule
      ? `if (params.has('surface')) {
    return <MobileSessionSurface controller={{
      insets,
      keyboardLift: collapsed ? 0 : Number(params.get('keyboard') ?? 0),
      dictation: { isRecording: params.has('mic') },
      nativeChatController: {
        showNativeChat: !params.has('hiddenchat'), nativeChatAsk: prompt, nativeChatStructured: !params.has('terminal'),
        nativeChatAgent: params.has('terminal') ? 'omp' : 'claude', nativeChatCollapsedPrompt: collapsed ? {} : null
      },
      fixtureContent: children,
      fixtureChromeHeight: Number(params.get('chrome') ?? 0)
    }} />
  }`
      : ''
  }
  return <><View style={{ height: Number(params.get('chrome') ?? 0), flexShrink: 0 }} />{children}</>
}

function PromptViewportFixture() {
  const [collapsed, setCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <SafeAreaProvider initialMetrics={{
      frame: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      insets
    }}>
      {/* The browser reports zero OS insets; this boundary supplies the phone's environment. */}
      <SafeAreaInsetsContext.Provider value={insets}>
      <RpcClientProvider client={client}>
        <SessionFrame collapsed={collapsed}>
        <MobileNativeChatView
          messages={context}
          folded={context}
          status="ready"
          streaming={null}
          pending={[]}
          micActive={params.has('mic')}
          onSend={async () => true}
          sendSurfaceId="prompt-viewport-fixture"
          getSendCompletionGeneration={() => 0}
          getComposerEditGeneration={() => 0}
          composerText={draft}
          onComposerTextChange={setDraft}
          agent="claude"
          attachments={params.has('attachment') ? [{ id: 'draft-image', path: '/tmp/draft-image.png', previewUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] : []}
          onRemoveAttachment={() => {}}
          ask={prompt}
          askKey="fixture-ask"
          askRequiresTerminal={params.has('terminal')}
          onAnswerInTerminal={() => {
            globalThis.__orcaPromptViewportTerminalNavigations = (globalThis.__orcaPromptViewportTerminalNavigations ?? 0) + 1
          }}
          onAnswerAsk={async (_, selections) => {
            globalThis.__orcaPromptViewportAnswers = selections
            return true
          }}
          onCancelAsk={async () => {
            globalThis.__orcaPromptViewportCancels = (globalThis.__orcaPromptViewportCancels ?? 0) + 1
            return true
          }}
          onCollapseAsk={() => setCollapsed(true)}
          collapsedPrompt={collapsed ? {
            title: 'Agent question',
            expand: () => setCollapsed(false)
          } : null}
          keyboardInset={collapsed && params.has('surface') ? 0 : Number(params.get('keyboard') ?? 0)}
        />
        </SessionFrame>
      </RpcClientProvider>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaProvider>
  )
}

createRoot(document.getElementById('root')).render(<PromptViewportFixture />)
`
}
