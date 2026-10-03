module github.com/stablyai/orca/mobile/sshtunnel

go 1.27.0

require golang.org/x/crypto v0.57.0

require (
	golang.org/x/mobile v0.0.0-20260908204917-8b95e45f8d3e // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/tools v0.50.0 // indirect
)

tool (
	golang.org/x/mobile/cmd/gobind
	golang.org/x/mobile/cmd/gomobile
)
