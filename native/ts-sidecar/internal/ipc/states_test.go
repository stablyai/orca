package ipc

import "testing"

func TestMapBackendState(t *testing.T) {
	cases := map[string]NodeState{
		"Running":          StateRunning,
		"NeedsLogin":       StateNeedsAuth,
		"NeedsMachineAuth": StateNeedsAuth,
		"Starting":         StateStarting,
		"NoState":          StateStarting,
		"Stopped":          StateStopped,
		"":                 StateStopped,
		"WeirdFutureState": StateStopped,
	}
	for backend, want := range cases {
		if got := MapBackendState(backend); got != want {
			t.Errorf("MapBackendState(%q) = %q, want %q", backend, got, want)
		}
	}
}
