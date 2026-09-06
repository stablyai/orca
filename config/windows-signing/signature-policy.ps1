function Assert-SigningCertificate($signature, [string]$path) {
  if ($env:SIGNING_POLICY -eq 'test-signing') {
    if ($env:TEST_CERTIFICATE_THUMBPRINT -notmatch '^[a-fA-F0-9]{40}$') {
      throw 'The rehearsal requires a pinned SIGNPATH_TEST_CERTIFICATE_THUMBPRINT.'
    }
    if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $env:TEST_CERTIFICATE_THUMBPRINT -or $signature.Status -notin @('Valid', 'NotTrusted')) {
      throw "Unexpected rehearsal signature: $path ($($signature.Status))"
    }
  } elseif ($env:SIGNING_POLICY -eq 'release-signing') {
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*CN=SignPath Foundation*') {
      throw "Invalid production signature: $path ($($signature.Status))"
    }
  } else { throw 'Unknown signing policy.' }
}
