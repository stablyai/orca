// Frame orderings captured from real `claude` runs driven the way Orca drives it (streaming input,
// client-minted user uuids, --replay-user-messages, partial messages). Reduced to what decides
// where a turn ends: order, type, uuid, sidechain parent and the result verdict.

export type CapturedClaudeFrame = {
  type: 'init' | 'user' | 'assistant' | 'result'
  uuid: string
  block?: string
  /** An echo of a message the client sent. */
  replay?: true
  parent?: string
  isError?: boolean
}

export const CAPTURED_CLAUDE_TURNS: Record<
  'interrupted' | 'steered' | 'subagent',
  readonly CapturedClaudeFrame[]
> = {
  interrupted: [
    { type: 'init', uuid: 'e18ec423-cb75-43d0-ad21-cdd8a8219550' },
    { type: 'user', uuid: 'ca14d6a8-1fe6-42ff-b885-82d34523a129', block: 'text', replay: true },
    { type: 'assistant', uuid: '739e0f55-cd41-4eea-b58d-30a6b2758d04', block: 'thinking' },
    { type: 'assistant', uuid: 'b77047d7-2e5d-4801-b58f-109acdb7336a', block: 'tool_use' },
    { type: 'user', uuid: '576cfee2-eac4-496a-bdeb-4a5bf23f87bc', block: 'tool_result' },
    { type: 'assistant', uuid: 'ae0ce11b-dd35-4dc3-9a98-c652cc8342aa', block: 'thinking' },
    { type: 'user', uuid: '70260824-4885-4efa-b05e-2149025fad7c', block: 'text' },
    { type: 'result', uuid: '2ed20642-1556-4b96-9db8-7956739103f0', isError: false },
    { type: 'init', uuid: '1ed83b8b-c5ca-47d3-ba42-9daebaba7205' },
    { type: 'user', uuid: 'eff32d48-0c73-4ba0-973b-9fd9bb9d8ad8', block: 'text', replay: true },
    { type: 'assistant', uuid: 'd0edb824-2e12-4123-9e7f-76a6c6b818ad', block: 'thinking' },
    { type: 'assistant', uuid: '6321f4c4-6600-4556-a998-61372eafe927', block: 'text' },
    { type: 'result', uuid: '7632f415-de06-4991-aac3-3078a24ed6be', isError: false }
  ],
  steered: [
    { type: 'init', uuid: 'f2b67eac-f28e-47d6-93e8-922bfe1f5593' },
    { type: 'user', uuid: '6c1a74f8-a8c4-49f3-a544-a4fb29e5cfb2', block: 'text', replay: true },
    { type: 'assistant', uuid: '116a4725-8043-4519-95ff-f657866ec506', block: 'tool_use' },
    { type: 'user', uuid: 'fcb810ab-36b6-42bc-8d07-07e0df71c6b0', block: 'tool_result' },
    { type: 'user', uuid: '4b765bbe-9a2c-4b9e-813c-f9bf261a88f9', block: 'text', replay: true },
    { type: 'assistant', uuid: '7a812a74-3094-4e53-9c10-2736f9ede6d0', block: 'thinking' },
    { type: 'assistant', uuid: '934a097e-026e-426c-bacf-379a77c4e53f', block: 'text' },
    { type: 'result', uuid: '1fc47174-2d06-4938-91b7-2f401aac5261', isError: false },
    { type: 'init', uuid: '760e2220-8a05-4b6b-bcec-1f129e628bb0' },
    { type: 'user', uuid: '108352fc-5263-4361-a030-8d4cc288879d', block: 'text', replay: true },
    { type: 'assistant', uuid: '816adc3e-1a52-4f66-96be-8dac8405ae8a', block: 'text' },
    { type: 'result', uuid: 'c126a1c3-42ad-4c04-8542-dc149acc9c11', isError: false }
  ],
  subagent: [
    { type: 'init', uuid: 'c8c2a48f-cccf-4305-bc90-2427465c82c7' },
    { type: 'user', uuid: '99494862-7c8b-4c77-9464-2872652b4585', block: 'text', replay: true },
    { type: 'assistant', uuid: '0a821973-d8bb-4ac6-aaa6-8ed0c14cfa73', block: 'tool_use' },
    { type: 'user', uuid: '145e92e8-dd63-45df-8935-22a255a9020f', block: 'tool_result' },
    {
      type: 'assistant',
      uuid: '3010d8c0-8907-409e-909b-62d7b7a89055',
      block: 'tool_use',
      parent: 'toolu_01CK35HiJUdrXeT2oxrKRvV5'
    },
    {
      type: 'user',
      uuid: '64f7fec6-b61a-4a85-83da-1b509db5543d',
      block: 'tool_result',
      parent: 'toolu_01CK35HiJUdrXeT2oxrKRvV5'
    },
    { type: 'assistant', uuid: 'aa343fce-40e9-48eb-b5cd-1bbe5a66d141', block: 'thinking' },
    { type: 'assistant', uuid: 'd0b39adb-ab68-400e-a6f1-77682740ee9e', block: 'text' },
    { type: 'result', uuid: 'd15c4984-84ec-4460-934e-c74cdc730dda', isError: false },
    {
      type: 'assistant',
      uuid: '656e9e64-c104-4f3a-b241-c16164059e6d',
      block: 'thinking',
      parent: 'toolu_01CK35HiJUdrXeT2oxrKRvV5'
    },
    {
      type: 'assistant',
      uuid: 'd7b80c64-5ae1-457a-8b60-df842dd48d41',
      block: 'text',
      parent: 'toolu_01CK35HiJUdrXeT2oxrKRvV5'
    },
    { type: 'init', uuid: 'f3a1f869-3c16-4f8f-b002-5d11e4237f0f' },
    { type: 'assistant', uuid: 'dfa6bf78-0147-4583-8390-3a1202c722fd', block: 'thinking' },
    { type: 'assistant', uuid: '73d44e6e-52ae-40fd-b4e4-cf225c955d67', block: 'text' },
    { type: 'result', uuid: 'd8d6dcf1-89d1-4f1e-a5c2-51ff4210980c', isError: false },
    { type: 'init', uuid: 'b8c3fd02-a6ea-4fcf-ba14-a1eb5f37b188' },
    { type: 'user', uuid: '0536818e-0fd7-4bb8-8936-fbe1de875b3d', block: 'text', replay: true },
    { type: 'assistant', uuid: '8bdb741b-8423-4c73-9185-733d17b922fe', block: 'text' },
    { type: 'result', uuid: 'f239fff4-6005-4c55-89d3-a37f018d437a', isError: false }
  ]
}
