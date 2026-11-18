import { expect, it } from 'vitest'
import {
  createFakeRpcClient,
  rpcSuccess
} from '../../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { loadMobileDiffReviewDiff, type MobileReviewDiffInput } from './mobile-diff-review-loaders'

const INPUT: MobileReviewDiffInput = {
  itemKey: 'unstaged:logo.png',
  scope: 'unstaged',
  filePath: 'logo.png',
  oldPath: null,
  deleted: false,
  statusRevision: null,
  baseRef: null,
  baseOid: null,
  headOid: null,
  mergeBase: null,
  commitOid: null,
  parentOid: null,
  ignoreTrimWhitespace: true
}

async function loadWithHostReply(result: unknown) {
  const client = createFakeRpcClient()
  const loading = loadMobileDiffReviewDiff(client, 'wt-1', INPUT)
  await Promise.resolve()
  client.requests.at(-1)?.resolve(rpcSuccess('diff', result))
  return loading
}

const binarySides = {
  kind: 'binary',
  originalIsBinary: true,
  modifiedIsBinary: true,
  originalContent: '',
  modifiedContent: ''
}

it('shows the changed image instead of a binary placeholder', async () => {
  await expect(
    loadWithHostReply({
      ...binarySides,
      modifiedContent: 'iVBORw0KGgo=',
      isImage: true,
      mimeType: 'image/png'
    })
  ).resolves.toEqual({
    kind: 'image',
    itemKey: 'unstaged:logo.png',
    dataUri: 'data:image/png;base64,iVBORw0KGgo='
  })
})

it('calls a side past the host read cap too large rather than binary', async () => {
  await expect(loadWithHostReply({ ...binarySides, tooLarge: true })).resolves.toEqual({
    kind: 'too-large',
    itemKey: 'unstaged:logo.png',
    byteLength: undefined
  })
})
