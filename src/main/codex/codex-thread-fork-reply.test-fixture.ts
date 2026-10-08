// A real `thread/fork { threadId, lastTurnId }` reply from codex-cli 0.160.1 app-server, cut through
// the first of the parent's two turns. Paths are scrubbed; ids, turns and items are as Codex sent.

export const CODEX_THREAD_FORK_CAPTURE = {
  parentThreadId: '01a117ce-bccf-7f12-bb4b-170ca4bf556b',
  reply: {
    thread: {
      id: '01a117cf-095a-78b3-9cdb-a3f14e0b0ab0',
      environments: [
        {
          environmentId: 'local',
          cwd: '/workspace',
          runtimeWorkspaceRoots: ['/workspace']
        }
      ],
      extra: null,
      sessionId: '01a117cf-095a-78b3-9cdb-a3f14e0b0ab0',
      forkedFromId: '01a117ce-bccf-7f12-bb4b-170ca4bf556b',
      parentThreadId: null,
      preview: '',
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: 'paginated',
      modelProvider: 'openai',
      model: 'gpt-6.1-sol',
      reasoningEffort: null,
      createdAt: 1791400806,
      updatedAt: 1791400806,
      recencyAt: 1791400806,
      status: {
        type: 'idle'
      },
      path: '/home/user/.codex/sessions/2026/10/07/rollout-2026-10-07T19-20-06-01a117cf-095a-78b3-9cdb-a3f14e0b0ab0.jsonl',
      cwd: '/workspace',
      cliVersion: '0.160.1',
      originator: 'orca_probe',
      source: 'vscode',
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      daybreakEnabled: null,
      turns: [
        {
          id: '01a117ce-c592-71f2-88d4-dd2900d1c2fc',
          items: [
            {
              type: 'userMessage',
              id: '01a117ce-cf26-7a62-b10d-6c77cdac493e',
              clientId: null,
              content: [
                {
                  type: 'text',
                  text: 'Run the shell command echo one and then reply with exactly the word one.',
                  text_elements: []
                }
              ]
            },
            {
              type: 'agentMessage',
              id: 'msg_09a2727a664435a2016ac69b5a36e087d2822f122ba6d0b53b',
              text: 'I’ll run the command now.\n',
              phase: 'commentary',
              memoryCitation: null,
              delivery: null,
              questions: null
            },
            {
              type: 'commandExecution',
              id: 'exec-6c629441-aa33-473c-a97a-f7d84c054e2f',
              pluginId: null,
              scriptPath: null,
              command: "/bin/zsh -lc 'echo one'",
              cwd: '/workspace',
              processId: '7491',
              source: 'unifiedExecStartup',
              status: 'completed',
              commandActions: [
                {
                  type: 'unknown',
                  command: 'echo one'
                }
              ],
              aggregatedOutput: 'one\n',
              exitCode: 0,
              durationMs: 0
            },
            {
              type: 'agentMessage',
              id: 'msg_09a2727a664435a2016ac69b5ea54c87d2a6516a87f0a6c330',
              text: 'one',
              phase: 'final_answer',
              memoryCitation: null,
              delivery: null,
              questions: null
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: 1791400789,
          completedAt: 1791400799,
          durationMs: 9749
        }
      ]
    },
    model: 'gpt-6.1-sol',
    reasoningEffort: null,
    serviceTier: null
  }
}
