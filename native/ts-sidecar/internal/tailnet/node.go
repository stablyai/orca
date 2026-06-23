// Package tailnet adapts tsnet to the ipc.Node interface the dispatcher drives.
// This is the imperative shell: it is the only place that imports tsnet, which
// keeps the ipc package (and its tests) free of the heavy tailscale dependency.
package tailnet

import (
	"context"
	"strings"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"

	"github.com/stablyai/orca/native/ts-sidecar/internal/ipc"
)

// Node wraps a started tsnet.Server and reports tailnet status to the desktop.
type Node struct {
	srv       *tsnet.Server
	lc        *local.Client
	socksPort int
}

// New builds a Node over an already-started tsnet.Server. socksPort is the
// loopback port of the outbound SOCKS5 proxy, surfaced in status so the desktop
// knows where to dial.
func New(srv *tsnet.Server, socksPort int) (*Node, error) {
	lc, err := srv.LocalClient()
	if err != nil {
		return nil, err
	}
	return &Node{srv: srv, lc: lc, socksPort: socksPort}, nil
}

// Status reports the current tailnet state. It never errors: a failure to reach
// the local backend is reported as Stopped so the UI degrades gracefully.
func (n *Node) Status() ipc.StatusResult {
	res := ipc.StatusResult{State: ipc.StateStopped, SocksPort: n.socksPort}
	st, err := n.lc.StatusWithoutPeers(context.Background())
	if err != nil {
		return res
	}
	res.State = ipc.MapBackendState(st.BackendState)
	res.AuthURL = st.AuthURL
	if len(st.TailscaleIPs) > 0 {
		res.TailnetIP = st.TailscaleIPs[0].String()
	}
	if st.Self != nil {
		// DNSName is a FQDN ending in a dot; trim it for display/dialing.
		res.MagicDNSName = strings.TrimSuffix(st.Self.DNSName, ".")
	}
	return res
}

// Up starts interactive login if the node is not yet authenticated. With a
// persisted node key this is a no-op that simply confirms the node is up.
func (n *Node) Up(ctx context.Context) error {
	return n.lc.StartLoginInteractive(ctx)
}

// Down takes the node offline without discarding its persisted node key, so the
// next Up does not require re-authentication.
func (n *Node) Down() error {
	_, err := n.lc.EditPrefs(context.Background(), &ipn.MaskedPrefs{
		Prefs:          ipn.Prefs{WantRunning: false},
		WantRunningSet: true,
	})
	return err
}
