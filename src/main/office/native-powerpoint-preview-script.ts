// Why: PowerPoint itself is the only installed renderer that reliably preserves
// Office-only shapes, charts, effects, and fonts in visually dense decks.
export const NATIVE_POWERPOINT_PREVIEW_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$ImageDirectory,
  [Parameter(Mandatory = $true)][string]$ProcessIdPath
)

$ErrorActionPreference = 'Stop'
$powerPoint = $null
$source = $null
$preview = $null

try {
  $existingProcessIds = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $createdProcess = Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
    Where-Object { $existingProcessIds -notcontains $_.Id } |
    Select-Object -First 1
  if ($createdProcess -ne $null) {
    [IO.File]::WriteAllText($ProcessIdPath, [string]$createdProcess.Id)
  }
  $source = $powerPoint.Presentations.Open($InputPath, $true, $false, $false)
  $preview = $powerPoint.Presentations.Add($false)

  while ($preview.Slides.Count -gt 0) {
    $preview.Slides.Item(1).Delete()
  }

  $slideWidth = $source.PageSetup.SlideWidth
  $slideHeight = $source.PageSetup.SlideHeight
  $preview.PageSetup.SlideWidth = $slideWidth
  $preview.PageSetup.SlideHeight = $slideHeight
  $pixelWidth = 1920
  $pixelHeight = [Math]::Max(1, [int]($pixelWidth * $slideHeight / $slideWidth))

  for ($index = 1; $index -le $source.Slides.Count; $index += 1) {
    $imagePath = Join-Path $ImageDirectory ("slide-{0}.png" -f $index)
    $source.Slides.Item($index).Export($imagePath, 'PNG', $pixelWidth, $pixelHeight)
    $slide = $preview.Slides.Add($index, 12)
    [void]$slide.Shapes.AddPicture($imagePath, $false, $true, 0, 0, $slideWidth, $slideHeight)
  }

  $preview.SaveAs($OutputPath, 24)
} finally {
  if ($preview -ne $null) { $preview.Close() }
  if ($source -ne $null) { $source.Close() }
  if ($powerPoint -ne $null) { $powerPoint.Quit() }
  if ($preview -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($preview) }
  if ($source -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($source) }
  if ($powerPoint -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`
