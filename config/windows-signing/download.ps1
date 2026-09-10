$ErrorActionPreference = 'Stop'
if ($env:SIGNPATH_REQUEST_ID -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Missing original signing request.' }
$root = 'https://app.signpath.io/Api/v1/c37aa192-a27a-4377-9c90-5d6c95912dc0/SigningRequests'
$headers = @{ Authorization = "Bearer $env:SIGNPATH_API_TOKEN" }
$request = Invoke-RestMethod -Uri "$root/$env:SIGNPATH_REQUEST_ID" -Headers $headers -TimeoutSec 30 -MaximumRedirection 0
$expectedConfig = if ($env:STAGE -eq 'inner') { 'windows-inner-binaries-zip' } else { 'github-actions-windows-installer' }
if ($request.status -ne 'Completed' -or -not $request.isFinalStatus -or $request.projectSlug -ne 'orca' -or $request.signingPolicySlug -ne $env:SIGNING_POLICY -or $request.artifactConfigurationSlug -ne $expectedConfig) { throw 'The original signing request is not successfully completed under the expected policy.' }
$expectedBuild = "^https://github\.com/$([regex]::Escape($env:GITHUB_REPOSITORY))/actions/runs/$env:GITHUB_RUN_ID(/job/[0-9]+)?/?$"
$expectedRepository = "^https://github\.com/$([regex]::Escape($env:GITHUB_REPOSITORY))(\.git)?/?$"
if ($request.origin.buildData.url -cnotmatch $expectedBuild -or $request.origin.repositoryData.url -cnotmatch $expectedRepository -or $request.origin.repositoryData.commitId -cne $env:GITHUB_SHA) { throw 'Signed artifact provenance does not match this release run.' }
# Approval is complete; the timeout bounds artifact transfer only.
Get-SignedArtifact -OrganizationId c37aa192-a27a-4377-9c90-5d6c95912dc0 -ApiToken $env:SIGNPATH_API_TOKEN -SigningRequestId $env:SIGNPATH_REQUEST_ID -OutputArtifactPath signed-artifact.zip -Force -WaitForCompletionTimeoutInSeconds 30
if ($env:STAGE -eq 'inner') {
  New-Item -ItemType Directory -Path signed-inner -Force | Out-Null
  Expand-Archive -LiteralPath signed-artifact.zip -DestinationPath signed-inner -Force
} elseif ($env:STAGE -eq 'installer') {
  New-Item -ItemType Directory -Path signed-installer -Force | Out-Null
  Expand-Archive -LiteralPath signed-artifact.zip -DestinationPath signed-installer -Force
  $installers = @(Get-ChildItem signed-installer -Recurse -File -Filter orca-windows-setup.exe)
  if ($installers.Count -ne 1) { throw 'Exactly one signed Windows installer is required.' }
  Copy-Item -LiteralPath $installers[0].FullName -Destination dist/orca-windows-setup.exe -Force
} else { throw 'Invalid signing stage.' }
