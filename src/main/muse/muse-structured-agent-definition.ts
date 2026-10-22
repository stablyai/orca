import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

export const MUSE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'muse',
  handleTransport: 'msp',
  // Muse scopes its account to the home directory: auth, sessions, and skills all
  // live under it, so a record pins the home the child ran with.
  accountHomeVariable: 'HOME',
  capabilities: {
    rewind: false,
    // MSP session/compact stays unwired in v1, so the registry must not
    // demand an adapter compact method it does not have yet.
    compact: false,
    threadGoal: false,
    contextUsage: false,
    imagePrompts: true,
    steering: 'inject',
    approvalEnforcement: 'provider'
  },
  restingOptions: {
    acceptsKey: (key) => key === 'model' || key === 'effort' || key === 'permissionProfile',
    fallbackModels: () => [
      {
        id: 'muse-spark-1.3',
        label: 'Spark 1.3',
        isDefault: true,
        efforts: [
          { value: 'none', label: 'None' },
          { value: 'minimal', label: 'Minimal' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' },
          { value: 'ultra', label: 'Ultra' }
        ]
      }
    ],
    effortDefaultsToModel: true
  }
}

/** Orca session option keys this adapter takes while a child runs. */
export const MUSE_SESSION_OPTION_KEYS = ['model', 'effort', 'permissionProfile'] as const

/** Orca permission profiles onto MSP approval modes: the server default runs
 *  when no profile was picked, so only an explicit pick is sent. */
export const MUSE_PERMISSION_PROFILE_APPROVAL_MODES: Record<string, string> = {
  ':unrestricted': 'allowAll',
  ':ask-me': 'promptUnmatched',
  ':auto-review': 'promptUnmatched',
  ':read-only': 'denyUnmatched'
}
