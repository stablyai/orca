package sshtunnel

import (
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

// jumpConfiguration is one hop in front of the target SSH server. The target
// name is sent to the jump host as a string, so the jump host resolves it.
type jumpConfiguration struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
	Password           string `json:"password"`
	PrivateKey         string `json:"privateKey"`
	Passphrase         string `json:"passphrase"`
}

// configuration is the SSH connection(s) plus the socket destination dialed
// from the target SSH server. Jump is optional; without it the target name
// resolves on the phone.
type configuration struct {
	Host               string             `json:"host"`
	Port               int                `json:"port"`
	Username           string             `json:"username"`
	TargetHost         string             `json:"targetHost"`
	TargetPort         int                `json:"targetPort"`
	HostKeyFingerprint string             `json:"hostKeyFingerprint"`
	Password           string             `json:"password"`
	PrivateKey         string             `json:"privateKey"`
	Passphrase         string             `json:"passphrase"`
	Jump               *jumpConfiguration `json:"jump"`
}

func parseConfiguration(raw string) (configuration, error) {
	var c configuration
	if len(raw) > 131072 || json.Unmarshal([]byte(raw), &c) != nil {
		return c, errors.New("SSH_CONFIG_INVALID")
	}
	// The socket target is only needed by Open; Probe sends host and port alone.
	if !validHost(c.Host, c.Port) {
		return c, errors.New("SSH_CONFIG_INVALID")
	}
	if c.Jump != nil && !validHost(c.Jump.Host, c.Jump.Port) {
		return c, errors.New("SSH_CONFIG_INVALID")
	}
	return c, nil
}

func validHost(host string, port int) bool {
	return host != "" && len(host) <= 253 && !strings.ContainsAny(host, " /@?#\t\r\n") && port >= 1 && port <= 65535
}

func (c configuration) address() string {
	return net.JoinHostPort(strings.Trim(c.Host, "[]"), strconv.Itoa(c.Port))
}

func (c configuration) destination() string {
	return net.JoinHostPort(strings.Trim(c.TargetHost, "[]"), strconv.Itoa(c.TargetPort))
}

func (j jumpConfiguration) address() string {
	return net.JoinHostPort(strings.Trim(j.Host, "[]"), strconv.Itoa(j.Port))
}

func (c configuration) targetAuth() ([]ssh.AuthMethod, error) {
	if c.Username == "" || len(c.Username) > 256 || c.HostKeyFingerprint == "" {
		return nil, errors.New("SSH_CONFIG_INVALID")
	}
	return authMethods(c.Password, c.PrivateKey, c.Passphrase)
}

func (j jumpConfiguration) auth() ([]ssh.AuthMethod, error) {
	if j.Username == "" || len(j.Username) > 256 || j.HostKeyFingerprint == "" {
		return nil, errors.New("SSH_CONFIG_INVALID")
	}
	return authMethods(j.Password, j.PrivateKey, j.Passphrase)
}

func authMethods(password, privateKey, passphrase string) ([]ssh.AuthMethod, error) {
	if privateKey != "" {
		var signer ssh.Signer
		var err error
		if passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(privateKey))
		}
		if err != nil {
			return nil, errors.New("SSH_KEY_INVALID")
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	if password == "" {
		return nil, errors.New("SSH_CREDENTIAL_MISSING")
	}
	return []ssh.AuthMethod{ssh.Password(password)}, nil
}
