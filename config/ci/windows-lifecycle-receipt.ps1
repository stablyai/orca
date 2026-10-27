function Write-WindowsLifecycleReceipt([hashtable]$Report,[string]$Receipt) {
  try {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Report | ConvertTo-Json -Depth 6))
    $temporary="$Receipt.pending"
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    [IO.File]::Move($temporary,$Receipt,$true)
    return $true
  } catch {return $false}
}
