export function readOrcadBunSshTestFile(argv, fallback) {
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  return forwarded[0] ?? fallback
}
