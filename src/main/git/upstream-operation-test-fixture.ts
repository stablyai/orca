export const configuredFeatureUpstream = {
  stdout: 'refs/remotes/origin/feature\0=\0refs/heads/feature\0origin\0refs/heads/feature\n',
  stderr: ''
}

export const upstreamMetadataArgs = [
  'for-each-ref',
  '--format=%(upstream)%00%(upstream:trackshort)%00%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)',
  'refs/heads/feature'
]
